import assert from "node:assert/strict";
import { RedisClient } from "bun";
import { createClient } from "redis";
import { Redis as IORedis } from "ioredis";
import { Redis as UpstashRedis } from "@upstash/redis";
import { RedisBotStorage, adaptNodeRedis, adaptUpstashRedis } from "../src/redis";
import { withDeadline } from "../src/deadline";

const url = process.env.NOSKRAP_TEST_REDIS_URL;
if (!url) throw new Error("Set NOSKRAP_TEST_REDIS_URL to disposable Redis 7+ before testing SDKs.");
const prefix = `noskrap-sdk:${crypto.randomUUID()}:`;
const backend = new RedisClient(url);
const node = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 1000, reconnectStrategy: false } });
node.on("error", error => console.error("Redis SDK test connection:", error.message));
const io = new IORedis(url, { lazyConnect: true, commandTimeout: 1000, connectTimeout: 1000, enableOfflineQueue: false, retryStrategy: () => null });
io.on("error", error => console.error("ioredis test connection:", error.message));
const keys = new Set<string>();
let rest: ReturnType<typeof Bun.serve> | undefined;
try {
  await node.connect();
  await io.connect();
  // Exercise the real Upstash HTTP SDK against a local REST-to-Redis bridge.
  // No hosted service credentials or vendor-specific mock methods are used.
  rest = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    assert.equal(request.headers.get("authorization"), "Bearer integration-token");
    const command: unknown = await request.json();
    assert(Array.isArray(command) && command.every(value => typeof value === "string" || typeof value === "number"));
    const [name, ...args] = command;
    assert(typeof name === "string");
    try {
      return Response.json({ result: await backend.send(name, args.map(String)) });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "command failed" });
    }
  } });
  const upstashOptions = { url: `http://127.0.0.1:${rest.port}`, token: "integration-token", retry: false as const,
    responseEncoding: false as const, enableAutoPipelining: false };
  const clients = [
    ["node-redis", adaptNodeRedis(node)],
    ["ioredis", io],
    ["upstash", adaptUpstashRedis(new UpstashRedis(upstashOptions), signal => new UpstashRedis({ ...upstashOptions, signal }))],
  ] as const;
  const now = Date.now();
  for (const [name, client] of clients) {
    const keyPrefix = `${prefix}${name}:`;
    const store = new RedisBotStorage(client, { keyPrefix, now: () => now });
    keys.add(`${keyPrefix}visitor:visitor`);
    const counterKey = `${keyPrefix}counter:route:${Math.floor(now / 60000)}`;
    keys.add(counterKey);
    const signal = new AbortController().signal;
    await Promise.all(Array.from({ length: 10 }, (_, index) => store.setVisitor("visitor", { id: "visitor", lastSeen: index, lastInteractionAt: index }, 600, signal)));
    assert.deepEqual(await store.getVisitor("visitor", signal), { id: "visitor", lastSeen: 9, lastInteractionAt: 9 });
    assert.equal(Math.max(...await Promise.all(Array.from({ length: 10 }, () => store.incrementCounter("route", 60, signal)))), 10);
    assert(Number(await backend.send("TTL", [counterKey])) > 0);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(store.incrementCounter("route", 60, abort.signal));
    assert.equal(await backend.get(counterKey), "10");
    console.log(`${name}: real SDK reads, atomic Lua updates, concurrency, expiry and pre-abort passed.`);
  }
  // Node-redis propagates an already aborted command option to the actual SDK.
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(adaptNodeRedis(node).withSignal!(abort.signal).get("ignored"));
  const stalled = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  try {
    const make = (signal?: AbortSignal) => new UpstashRedis({ ...upstashOptions, url: `http://127.0.0.1:${stalled.port}`, signal });
    const store = new RedisBotStorage(adaptUpstashRedis(make(), make));
    let pending: Promise<unknown> | undefined;
    await assert.rejects(withDeadline(signal => {
      pending = store.getVisitor("stalled", signal);
      return pending;
    }, 20), /timed out/);
    await withDeadline(() => pending?.catch(() => {}), 200);
    console.log("Upstash: stalled HTTP request receives operation cancellation.");
  } finally { stalled.stop(true); }
} finally {
  rest?.stop(true);
  if (node.isOpen) node.destroy();
  io.disconnect();
  if (keys.size) await backend.send("DEL", [...keys]);
  backend.close();
}
