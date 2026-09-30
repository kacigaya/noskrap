import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { RedisClient } from "bun";
import { RedisBotStorage } from "../src/redis";

const redisUrl = process.env.NOSKRAP_TEST_REDIS_URL;
if (!redisUrl) throw new Error("Set NOSKRAP_TEST_REDIS_URL to a disposable Redis 7+ instance before running integration checks.");
const root = resolve(import.meta.dir, "..");
const prefix = `noskrap-test:${crypto.randomUUID()}:`;
const redis = new RedisClient(redisUrl);
const ownedKeys = new Set<string>();
let now = Date.now();
const storage = new RedisBotStorage({
  get: key => redis.get(key),
  eval: (script, count, ...args): Promise<unknown> => {
    for (const key of args.slice(0, count)) ownedKeys.add(key);
    return redis.send("EVAL", [script, String(count), ...args]);
  },
}, { keyPrefix: prefix, now: () => now });

await mkdir(join(root, "test-next-app"), { recursive: true });
const fixture = await mkdtemp(join(root, "test-next-app", "integration-"));
let nextProcess: ReturnType<typeof Bun.spawn> | undefined;
let backend: ReturnType<typeof Bun.serve> | undefined;
const logPath = join(fixture, "next.log");
try {
  await Promise.all(Array.from({ length: 20 }, (_, index) => storage.setVisitor("concurrent", {
    id: "concurrent", lastSeen: index, lastInteractionAt: index,
  }, 600)));
  assert.deepEqual(await storage.getVisitor("concurrent"), { id: "concurrent", lastSeen: 19, lastInteractionAt: 19 });
  assert(Number(await redis.send("TTL", [`${prefix}visitor:concurrent`])) > 0);
  const counts = await Promise.all(Array.from({ length: 20 }, () => storage.incrementCounter("burst", 60)));
  assert.equal(Math.max(...counts), 20);
  const bucket = Math.floor(now / 60000);
  const counterKey = `${prefix}counter:burst:${bucket}`;
  assert(Number(await redis.send("TTL", [counterKey])) > 0);
  await redis.send("PERSIST", [counterKey]);
  assert.equal(await storage.incrementCounter("burst", 60), 21);
  assert(Number(await redis.send("TTL", [counterKey])) > 0);
  now = (bucket + 1) * 60000;
  assert.equal(await storage.incrementCounter("burst", 60), 1);
  now = Date.now();
  const damagedKey = `${prefix}visitor:damaged`;
  ownedKeys.add(damagedKey);
  await redis.send("SET", [damagedKey, "not json"]);
  assert.equal(await storage.getVisitor("damaged"), null);
  await storage.setVisitor("damaged", { id: "damaged", lastSeen: now }, 1);
  await Bun.sleep(1100);
  assert.equal(await storage.getVisitor("damaged"), null);
  console.log("Real Redis: atomic merge, concurrent counters, TTL repair, rollover and expiry passed.");

  backend = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const parsed: unknown = await request.json();
      assert(Array.isArray(parsed));
      const args: unknown[] = parsed;
      assert(typeof args[0] === "string");
      const method = new URL(request.url).pathname;
      switch (method) {
        case "/getVisitor":
          return Response.json(await storage.getVisitor(args[0]));
        case "/setVisitor":
          assert(typeof args[2] === "number");
          const state = args[1];
          assert(typeof state === "object" && state !== null);
          assert("id" in state && typeof state.id === "string");
          assert("lastSeen" in state && typeof state.lastSeen === "number");
          assert("lastInteractionAt" in state && typeof state.lastInteractionAt === "number");
          await storage.setVisitor(args[0], {
            id: state.id, lastSeen: state.lastSeen,
            lastInteractionAt: state.lastInteractionAt,
          }, args[2]);
          return Response.json(null);
        case "/incrementCounter":
          assert(typeof args[1] === "number");
          return Response.json(await storage.incrementCounter(args[0], args[1]));
        default: return new Response(null, { status: 404 });
      }
    },
  });
  await cp(join(root, "tests/fixture"), fixture, { recursive: true });
  const dependencyRoot = resolve(process.env.NOSKRAP_TEST_NEXT_MODULES ?? join(root, "web/node_modules"));
  const nextPackage: unknown = await Bun.file(join(dependencyRoot, "next/package.json")).json();
  assert(typeof nextPackage === "object" && nextPackage !== null);
  assert("version" in nextPackage && typeof nextPackage.version === "string");
  const nextVersion = nextPackage.version;
  const next15 = nextVersion.startsWith("15.");
  if (next15) {
    const proxy = await Bun.file(join(fixture, "proxy.js")).text();
    await rename(join(fixture, "proxy.js"), join(fixture, "middleware.js"));
    await writeFile(join(fixture, "middleware.js"), proxy.replace("export const proxy =", "export const middleware ="));
    await writeFile(join(fixture, "next.config.mjs"), "export default {};\n");
  }
  await mkdir(join(fixture, "node_modules"));
  await symlink(root, join(fixture, "node_modules/noskrap"), "dir");
  for (const dependency of ["next", "react", "react-dom"]) {
    await symlink(join(dependencyRoot, dependency), join(fixture, "node_modules", dependency), "dir");
  }
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NOSKRAP_TEST_SECRET: "integration-secret-with-at-least-32-bytes", NOSKRAP_TEST_STORAGE_URL: `http://127.0.0.1:${backend.port}` };
  const nextBin = join(dependencyRoot, "next/dist/bin/next");
  const build = Bun.spawn(["node", nextBin, "build", ...(next15 ? [] : ["--webpack"])], { cwd: fixture, env, stdout: Bun.file(logPath), stderr: Bun.file(logPath) });
  assert.equal(await build.exited, 0, await Bun.file(logPath).text());
  const port = await new Promise<number>((resolvePort, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      assert(address && typeof address === "object");
      listener.close(() => resolvePort(address.port));
    });
  });
  nextProcess = Bun.spawn(["node", nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: fixture, env, stdout: Bun.file(logPath), stderr: Bun.file(logPath) });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    try { if ((await fetch(`${base}/bot-check`)).ok) break; } catch { /* Startup is asynchronous. */ }
    if (Date.now() >= deadline || nextProcess.exitCode !== null) throw new Error(await Bun.file(logPath).text());
    await Bun.sleep(100);
  }
  const browser = { "user-agent": "Mozilla/5.0", "sec-fetch-mode": "cors" };
  const initial = await fetch(`${base}/api/check`, { headers: browser });
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("x-noskrap-context"), null);
  assert(!Array.from(initial.headers.keys()).some(key => key.startsWith("x-middleware-request-")));
  const initialResult = await initial.json();
  const cookies = initial.headers.getSetCookie().map(value => value.split(";")[0]);
  assert(cookies.length > 0);
  assert.equal(new Set(cookies).size, 1, "Proxy and route must use the same first-request cookie");
  const cookie = cookies[0]!;
  assert.equal(initialResult.score, 15);
  for (let index = 1; index <= 31; index++) {
    const response = await fetch(`${base}/api/check`, { headers: { ...browser, cookie } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.reasons.some((reason: { ruleId: string }) => reason.ruleId === "rate.routeBurst"), index > 30, "The proxy and handler must increment once per request");
  }
  // Use a fresh visitor so the burst signal does not influence challenge checks.
  const fresh = await fetch(`${base}/api/check`, { headers: browser });
  const freshCookie = fresh.headers.getSetCookie()[0]!.split(";")[0]!;
  const post = () => fetch(`${base}/api/check`, { method: "POST", headers: { ...browser, cookie: freshCookie } });
  assert.equal((await (await post()).json()).score, 30);
  const telemetry = (proof: string) => fetch(`${base}/api/noskrap/telemetry`, { method: "POST", headers: { ...browser, cookie: freshCookie, "x-test-proof": proof }, body: '{"interacted":true}' });
  assert.equal((await telemetry("invalid")).status, 401);
  assert.equal((await telemetry("verified")).status, 200);
  assert.equal((await (await post()).json()).score, 0, "Telemetry must survive separate production bundles");
  const challengeVisitor = await fetch(`${base}/api/check`, { headers: browser });
  const challengeCookie = challengeVisitor.headers.getSetCookie()[0]!.split(";")[0]!;
  const challengeHeaders = { "user-agent": "HeadlessChrome", "sec-fetch-mode": "cors", cookie: challengeCookie };
  const challenged = await fetch(`${base}/api/check`, { method: "POST", headers: challengeHeaders, redirect: "manual" });
  assert.equal(challenged.status, 403);
  assert((await challenged.json()).challengeUrl.includes("/bot-check?next="));
  const form = await fetch(`${base}/api/check`, { method: "POST", headers: { ...challengeHeaders, "sec-fetch-mode": "navigate", accept: "text/html" }, body: "private=payload", redirect: "manual" });
  assert.equal(form.status, 303);
  const pass = await fetch(`${base}/api/noskrap/challenge-pass`, { method: "POST", headers: { ...challengeHeaders, "x-test-proof": "verified" } });
  assert.equal(pass.status, 200);
  const passCookies = pass.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const recovered = await fetch(`${base}/api/check`, { method: "POST", headers: { ...challengeHeaders, cookie: `${challengeCookie}; ${passCookies}` } });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).challengePassed, true);
  console.log(`Production Next.js ${nextVersion}: cookie forwarding, single scoring, shared telemetry, challenge POST and recovery passed.`);
} finally {
  nextProcess?.kill();
  if (nextProcess) await nextProcess.exited;
  backend?.stop(true);
  if (ownedKeys.size) await redis.send("DEL", Array.from(ownedKeys));
  redis.close();
  await rm(fixture, { recursive: true, force: true });
}
