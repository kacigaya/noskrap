import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryBotStorage, recordTelemetry, scoreRequest, signVisitorToken, validateConfig } from "./core.js";

const secret = "controls-test-secret-at-least-32-bytes";

test("unattended page views are opt-in, protected HTML GETs, and reset after telemetry", async () => {
  let now = 0;
  const config = { secret, storage: new MemoryBotStorage(() => now), now: () => now,
    protectedRoutes: ["/products"], maxPageViewsWithoutInteraction: 2 };
  const cookie = `noskrap_visitor=${await signVisitorToken({ id: "reader" }, secret)}`;
  const page = () => new Request("https://example.test/products/1", { headers: { cookie, accept: "text/html", "user-agent": "Mozilla/5.0" } });
  const unattended = async () => (await scoreRequest(page(), config)).reasons.some(reason => reason.ruleId === "behavior.noPageInteraction");
  assert.equal(await unattended(), false);
  assert.equal(await unattended(), false);
  assert.equal(await unattended(), true);
  now = 1;
  await recordTelemetry(page(), config, { interacted: true });
  assert.equal(await unattended(), false);
  now = 600001;
  assert.equal(await unattended(), false);
  assert.equal(await unattended(), false);
  assert.equal(await unattended(), true);
  for (const request of [
    new Request("https://example.test/products/1", { headers: { cookie, accept: "application/json" } }),
    new Request("https://example.test/products/1", { method: "HEAD", headers: { cookie, accept: "text/html" } }),
    new Request("https://example.test/public", { headers: { cookie, accept: "text/html" } }),
  ]) assert.equal((await scoreRequest(request, config)).reasons.some(reason => reason.ruleId === "behavior.noPageInteraction"), false);
  assert.equal((await scoreRequest(page(), { ...config, maxPageViewsWithoutInteraction: undefined })).reasons.some(reason => reason.ruleId === "behavior.noPageInteraction"), false);
});

test("unattended page tracking respects disabled rules and does not allocate cookie-less counters", async () => {
  const config = { secret, protectedRoutes: ["/"], maxPageViewsWithoutInteraction: 1,
    rules: [{ id: "rate.routeBurst", enabled: false }, { id: "behavior.cookieChurn", enabled: false }],
    storage: { getVisitor: async () => { throw new Error("unexpected read"); },
      setVisitor: async () => { throw new Error("unexpected write"); },
      incrementCounter: async () => { throw new Error("unexpected count"); } } };
  const request = new Request("https://example.test/", { headers: { accept: "text/html" } });
  assert.equal((await scoreRequest(request, config)).scoringAvailable, true);
  request.headers.set("cookie", `noskrap_visitor=${await signVisitorToken({ id: "reader" }, secret)}`);
  assert.equal((await scoreRequest(request, { ...config, rules: [...config.rules,
    { id: "behavior.noPageInteraction", enabled: false }] })).scoringAvailable, true);
});

test("custom signals receive cancellation, follow rules, and cap the total score", async () => {
  let received: AbortSignal | undefined;
  const config = { secret, storage: new MemoryBotStorage(), signals: (_request: Request, signal: AbortSignal) => {
    received = signal;
    return [{ ruleId: "custom.reputation", score: 40 }, { ruleId: "custom.network", score: 80 }];
  } };
  const request = new Request("https://example.test/api");
  assert.equal((await scoreRequest(request, config)).score, 100);
  assert.equal(received?.aborted, false);
  const overridden = await scoreRequest(request, { ...config, rules: [
    { id: "custom.reputation", score: 5 }, { id: "custom.network", enabled: false },
  ] });
  assert.deepEqual(overridden.reasons, [{ ruleId: "custom.reputation", score: 5 }]);
});

test("invalid custom signals and timeouts make scoring unavailable", async () => {
  for (const reasons of [
    [{ ruleId: "browser.automationUa", score: 1 }], [{ ruleId: "custom.bad", score: NaN }],
    [{ ruleId: "custom.bad", score: -1 }], [{ ruleId: "custom.bad", score: 101 }],
    [{ ruleId: "custom.same", score: 1 }, { ruleId: "custom.same", score: 2 }],
    Array.from({ length: 33 }, (_, index) => ({ ruleId: `custom.r${index}`, score: 1 })),
  ]) {
    const result = await scoreRequest(new Request("https://example.test/"), { secret, storage: new MemoryBotStorage(), signals: () => reasons });
    assert.equal(result.scoringAvailable, false);
    assert.deepEqual(result.reasons, []);
  }
  let cancelled = false;
  const result = await scoreRequest(new Request("https://example.test/"), {
    secret, storage: new MemoryBotStorage(), signalsTimeoutMs: 10,
    signals: (_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
    }),
  });
  assert.equal(result.scoringAvailable, false);
  assert.equal(cancelled, true);
});

test("automation patterns extend built-ins without mutable global regex state", async () => {
  const pattern = /MyCrawler/gi;
  pattern.lastIndex = 4;
  const config = { secret, storage: new MemoryBotStorage(), automationUserAgents: [pattern] };
  for (const agent of ["MyCrawler/1", "MyCrawler/1", "curl/8"]) {
    assert.equal((await scoreRequest(new Request("https://example.test/", { headers: { "user-agent": agent } }), config)).score, 30);
  }
  assert.equal(pattern.lastIndex, 4);
});

test("verified crawlers skip browser header checks but keep rate and custom policy", async () => {
  const request = new Request("https://example.test/products", { headers: {
    accept: "text/html", "user-agent": "Mozilla/5.0 Chrome/120.0 Googlebot/2.1",
  } });
  const config = { secret, protectedRoutes: ["/products"], storage: new MemoryBotStorage() };
  assert.equal((await scoreRequest(request, config)).score, 80);
  const verified = await scoreRequest(request, { ...config, verifyCrawler: () => true,
    signals: () => [{ ruleId: "custom.policy", score: 60 }] });
  assert.deepEqual(verified.reasons, [
    { ruleId: "behavior.noCookieContinuity", score: 15 }, { ruleId: "custom.policy", score: 60 },
  ]);
  assert.equal((await scoreRequest(request, { ...config, verifyCrawler: () => { throw new Error("DNS down"); } })).score, 80);
});

test("sliding counters retain a boundary burst, decay, and handle backward clocks conservatively", async () => {
  let now = 59000;
  const storage = new MemoryBotStorage(() => now);
  for (let count = 1; count <= 30; count++) assert.equal(await storage.incrementCounter("reader", 60), count);
  now = 60000;
  assert.equal(await storage.incrementCounter("reader", 60), 31);
  now = 90000;
  assert.equal(await storage.incrementCounter("reader", 60), 17);
  now = 59000;
  assert.equal(await storage.incrementCounter("reader", 60), 33);
  now = 240000;
  assert.equal(await storage.incrementCounter("reader", 60), 1);
});

test("new control options reject invalid limits at setup", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => validateConfig({ secret, maxPageViewsWithoutInteraction: value }), /positive safe integer/);
  }
  assert.throws(() => validateConfig({ secret, signalsTimeoutMs: 0 }), /signalsTimeoutMs/);
  assert.throws(() => validateConfig({ secret, crawlerTimeoutMs: 0 }), /crawlerTimeoutMs/);
});
