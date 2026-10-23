import { NextResponse } from "../tests/next-server.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryBotStorage, scoreRequest } from "./core.js";
import {
  createNoSkrapChallengePassHandler,
  createNoSkrapProxy,
  createNoSkrapTelemetryHandler,
  getNoSkrapDecision,
} from "./next.js";

const SECRET = "test-secret-with-at-least-32-bytes";

if (process.versions.bun) {
  const { mock } = await import("bun:test");
  mock.module("next/server", () => ({ NextResponse }));
}

test("route handler helper returns core decision", async () => {
  const result = await getNoSkrapDecision(
    new Request("https://example.test/", {
      headers: {
        accept: "text/html",
        "accept-language": "en-US,en;q=0.9",
        "sec-fetch-mode": "navigate",
        "user-agent": "Mozilla/5.0 Chrome/120 Safari/537.36",
      },
    }),
    { secret: SECRET },
  );

  assert.equal(result.decision, "allow");
  assert.ok((result.headers.get("set-cookie"))?.includes("noskrap_visitor="));
});

test("telemetry handler records interaction and returns cookie", async () => {
  const handler = createNoSkrapTelemetryHandler({
    secret: SECRET,
    verifyTelemetry: () => true,
  });
  const response = await handler(
    new Request("https://example.test/api/noskrap/telemetry", {
      method: "POST",
      body: JSON.stringify({ interacted: true }),
    }),
  );

  assert.equal(response.status, 200);
  assert.ok((response.headers.get("set-cookie"))?.includes("noskrap_visitor="));
});

test("challenge pass handler returns visitor and challenge cookies", async () => {
  const handler = createNoSkrapChallengePassHandler({
    secret: SECRET,
    verifyChallenge: () => true,
  });
  const visitor = await getNoSkrapDecision(
    new Request("https://example.test/"),
    { secret: SECRET },
  );
  const visitorCookie = visitor.headers.get("set-cookie")?.split(";")[0] ?? "";
  const response = await handler(
    new Request("https://example.test/api/noskrap/challenge-pass", {
      method: "POST",
      headers: { cookie: visitorCookie },
    }),
  );
  const cookie = response.headers.get("set-cookie");

  assert.equal(response.status, 200);
  assert.ok((cookie)?.includes("noskrap_challenge="));
});

test("handlers reject unverified client claims", async () => {
  const telemetry = createNoSkrapTelemetryHandler({
    secret: SECRET,
    verifyTelemetry: () => false,
  });
  const challenge = createNoSkrapChallengePassHandler({
    secret: SECRET,
    verifyChallenge: () => false,
  });

  assert.equal((
      await telemetry(
        new Request("https://example.test/api/noskrap/telemetry", {
          method: "POST",
          body: JSON.stringify({ interacted: true }),
        }),
      )
    ).status, 401);
  assert.equal((
      await challenge(
        new Request("https://example.test/api/noskrap/challenge-pass", {
          method: "POST",
        }),
      )
    ).status, 401);
});

test("proxy reports observed decisions", async () => {
  const observations: object[] = [];
  const proxy = createNoSkrapProxy({
    secret: SECRET,
    onDecision: (result) => { observations.push(result); },
  });

  const response = await proxy(new Request("https://example.test/"));

  assert.equal(response?.status, 200);
  assert.deepEqual(observations, [
    {
      decision: "allow",
      score: 0,
      reasons: [],
      challengePassed: false,
      scoringAvailable: true,
    },
  ]);
  assert.equal("headers" in observations[0]!, false);
  assert.ok((response?.headers.get("set-cookie"))?.includes("noskrap_visitor="));
});

test("proxy enforces block decisions", async () => {
  const proxy = createNoSkrapProxy({
    secret: SECRET,
    mode: "enforce",
    protectedRoutes: ["/api/search"],
  });

  const response = await proxy(
    new Request("https://example.test/api/search", {
      method: "POST",
      headers: { "user-agent": "curl/8.0" },
    }),
  );

  assert.equal(response?.status, 403);
  assert.ok((response?.headers.get("set-cookie"))?.includes("noskrap_visitor="));
});

test("proxy does not block in observe mode", async () => {
  const proxy = createNoSkrapProxy({
    secret: SECRET,
    protectedRoutes: ["/api/search"],
  });

  const response = await proxy(
    new Request("https://example.test/api/search", {
      method: "POST",
      headers: { "user-agent": "curl/8.0" },
    }),
  );

  assert.equal(response?.status, 200);
});

test("proxy redirects challenged visitors and keeps the cookie", async () => {
  const proxy = createNoSkrapProxy({
    secret: SECRET,
    mode: "enforce",
    challengePath: "/bot-check",
    storage: new MemoryBotStorage(),
    thresholds: { observe: 10, challenge: 20, block: 95 },
  });

  const response = await proxy(
    new Request("https://example.test/api/search", {
      headers: { "user-agent": "HeadlessChrome/120" },
    }),
  );

  assert.equal(response.status, 307);
  assert.equal(new URL(response!.headers.get("location")!).pathname, "/bot-check");
  assert.ok((response?.headers.get("set-cookie"))?.includes("noskrap_visitor="));
});

test("proxy lets challenge decisions through without a challenge path", async () => {
  const observations: { decision: string }[] = [];
  const proxy = createNoSkrapProxy({
    secret: SECRET,
    mode: "enforce",
    storage: new MemoryBotStorage(),
    thresholds: { observe: 10, challenge: 20, block: 95 },
    onDecision: (result) => { observations.push(result); },
  });

  const response = await proxy(
    new Request("https://example.test/api/search", {
      headers: { "user-agent": "HeadlessChrome/120" },
    }),
  );

  assert.equal(observations[0]?.decision, "challenge");
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("location"), null);
});

test("proxy replaces an invalid visitor cookie", async () => {
  const proxy = createNoSkrapProxy({
    secret: SECRET,
    storage: new MemoryBotStorage(),
  });

  const response = await proxy(
    new Request("https://example.test/", {
      headers: { cookie: "noskrap_visitor=invalid" },
    }),
  );

  const cookie = response?.headers.get("set-cookie") ?? "";
  assert.ok((cookie)?.includes("noskrap_visitor="));
  assert.ok(!(cookie)?.includes("noskrap_visitor=invalid"));
});

test("proxy keeps a valid visitor cookie stable", async () => {
  const proxy = createNoSkrapProxy({
    secret: SECRET,
    storage: new MemoryBotStorage(),
  });

  const first = await proxy(new Request("https://example.test/"));
  const cookie = first?.headers.get("set-cookie")?.split(";")[0] ?? "";
  const second = await proxy(
    new Request("https://example.test/", { headers: { cookie } }),
  );

  assert.ok((cookie)?.includes("noskrap_visitor="));
  assert.equal(second?.headers.get("set-cookie")?.split(";")[0], cookie);
});

test("proxy lets challenged visitors reach the challenge page", async () => {
  const proxy = createNoSkrapProxy({
    secret: SECRET,
    mode: "enforce",
    challengePath: "/bot-check",
    storage: new MemoryBotStorage(),
    thresholds: { observe: 10, challenge: 20, block: 95 },
  });

  const response = await proxy(
    new Request("https://example.test/bot-check", {
      headers: { "user-agent": "HeadlessChrome/120" },
    }),
  );

  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("location"), null);
  assert.ok((response?.headers.get("set-cookie"))?.includes("noskrap_visitor="));
});

test("proxy still blocks on the challenge page", async () => {
  const proxy = createNoSkrapProxy({
    secret: SECRET,
    mode: "enforce",
    challengePath: "/bot-check",
    storage: new MemoryBotStorage(),
    thresholds: { observe: 10, challenge: 20, block: 25 },
  });

  const response = await proxy(
    new Request("https://example.test/bot-check", {
      headers: { "user-agent": "HeadlessChrome/120" },
    }),
  );

  assert.equal(response?.status, 403);
});

function challengeRedirectNext(response: Response | undefined): string {
  const location = response?.headers.get("location");
  assert.notEqual(location, null);
  return new URL(location!).searchParams.get("next") ?? "";
}

test("proxy keeps the query string in the challenge return target", async () => {
  const proxy = createNoSkrapProxy({
    secret: SECRET,
    mode: "enforce",
    challengePath: "/bot-check",
    storage: new MemoryBotStorage(),
    thresholds: { observe: 10, challenge: 20, block: 95 },
  });

  const response = await proxy(
    new Request("https://example.test/api/search?q=foo", {
      headers: { "user-agent": "HeadlessChrome/120" },
    }),
  );

  assert.equal(challengeRedirectNext(response), "/api/search?q=foo");
});

test("proxy keeps the challenge return target same-origin", async () => {
  const proxy = createNoSkrapProxy({
    secret: SECRET,
    mode: "enforce",
    challengePath: "/bot-check",
    storage: new MemoryBotStorage(),
    thresholds: { observe: 10, challenge: 20, block: 95 },
  });

  const response = await proxy(
    new Request("https://example.test//evil.com/x", {
      headers: { "user-agent": "HeadlessChrome/120" },
    }),
  );

  const next = challengeRedirectNext(response);

  assert.equal(next, "/evil.com/x");
  assert.equal(new URL(next, "https://example.test").origin, "https://example.test");
});

test("telemetry handler rejects an oversized streamed body", async () => {
  // No content-length header, so only a limit applied while reading can catch
  // this.
  const payload = JSON.stringify({ interacted: true, pad: "x".repeat(4096) });
  const request = new Request("https://example.test/api/noskrap/telemetry", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);

  assert.equal(request.headers.get("content-length"), null);

  const handler = createNoSkrapTelemetryHandler({
    secret: SECRET,
    verifyTelemetry: () => true,
  });

  assert.equal((await handler(request)).status, 413);
});

test("telemetry handler rejects an oversized declared body", async () => {
  const handler = createNoSkrapTelemetryHandler({
    secret: SECRET,
    verifyTelemetry: () => true,
  });
  const response = await handler(
    new Request("https://example.test/api/noskrap/telemetry", {
      method: "POST",
      body: JSON.stringify({ interacted: true, pad: "x".repeat(4096) }),
    }),
  );

  assert.equal(response.status, 413);
});

test("telemetry handler rejects a body that is not JSON", async () => {
  const handler = createNoSkrapTelemetryHandler({
    secret: SECRET,
    verifyTelemetry: () => true,
  });
  const response = await handler(
    new Request("https://example.test/api/noskrap/telemetry", {
      method: "POST",
      body: "not json",
    }),
  );

  assert.equal(response.status, 400);
});

function forwardedRequest(request: Request, response: Response): Request {
  const headers = new Headers(request.headers);
  for (const name of (response.headers.get("x-middleware-override-headers") ?? "").split(",")) {
    const value = response.headers.get(`x-middleware-request-${name}`);
    if (name && value !== null) headers.set(name, value);
  }
  return new Request(request, { headers });
}

test("proxy decision is reused with one counter increment and a stable first cookie", async () => {
  let increments = 0;
  const storage = new MemoryBotStorage();
  const original = storage.incrementCounter.bind(storage);
  storage.incrementCounter = async (key, window) => { increments++; return original(key, window); };
  const config = { secret: SECRET, storage, protectedRoutes: ["/api"], getClientIp: () => "trusted" };
  const request = new Request("https://example.test/api/check", { headers: { cookie: "session=keep" } });
  const response = await createNoSkrapProxy(config)(request);
  const forwarded = forwardedRequest(request, response);
  const result = await getNoSkrapDecision(forwarded, config);
  assert.equal(increments, 2); // IP route and new-visitor counters, once each
  assert.equal(result.score, 15);
  assert.equal(result.headers.get("set-cookie"), response.headers.get("set-cookie"));
  assert.ok((forwarded.headers.get("cookie"))?.includes("session=keep"));
});

test("context binds path, query and a host the proxy saw", async () => {
  const config = { secret: SECRET, storage: new MemoryBotStorage() };
  // Next.js can give the proxy `localhost` while the Host header is the real one.
  const request = new Request("http://localhost:3000/products?page=2", {
    headers: { host: "127.0.0.1:3000", "user-agent": "curl/8" },
  });
  const forwarded = forwardedRequest(request, await createNoSkrapProxy(config)(request));
  const { readContext } = await import("./context.js");
  // A Server Component rebuilds the URL from the Host header.
  const rebuilt = new Request("https://127.0.0.1:3000/products?page=2", { headers: forwarded.headers });
  assert.deepEqual((await readContext(rebuilt, config))?.reasons.map(reason => reason.ruleId), ["browser.automationUa"]);
  assert.equal(await readContext(new Request("https://127.0.0.1:3000/products?page=3", { headers: forwarded.headers }), config), null);
  const otherSite = new Headers(forwarded.headers);
  otherSite.set("host", "tenant-b.example");
  assert.equal(await readContext(new Request("https://tenant-b.example/products?page=2", { headers: otherSite }), config), null);
});

test("context signing uses an explicit Host when the rebuilt request lost it", async () => {
  const config = { secret: SECRET, storage: new MemoryBotStorage() };
  const { readContext, signContext } = await import("./context.js");
  // Node.js drops Host from `new Request(destination, { headers })`.
  const rebuilt = new Request("http://localhost:3000/api/check");
  const decision = await scoreRequest(rebuilt, config);
  const cookie = decision.headers.get("set-cookie")!.split(";")[0];
  const token = await signContext(rebuilt, decision, config, true, "127.0.0.1:3000");
  const handler = new Request("http://localhost:3000/api/check", {
    headers: { host: "127.0.0.1:3000", cookie, "x-noskrap-context": token },
  });
  assert.notEqual(await readContext(handler, config), null);
});

test("contexts reject tampering, changed URL/method/cookie, expiry and wrong secrets", async () => {
  let now = 1000;
  const config = { secret: SECRET, storage: new MemoryBotStorage(), now: () => now };
  const request = new Request("https://example.test/api/check?long=" + "x".repeat(20000));
  const response = await createNoSkrapProxy(config)(request);
  const forwarded = forwardedRequest(request, response);
  const token = forwarded.headers.get("x-noskrap-context")!;
  assert.ok((token.length) < (8192));
  const { readContext } = await import("./context.js");
  assert.notEqual(await readContext(forwarded, config), null);
  for (const altered of [
    new Request("https://example.test/other", { headers: forwarded.headers }),
    new Request(forwarded.url, { method: "POST", headers: forwarded.headers }),
    new Request(forwarded.url, { headers: { "x-noskrap-context": token, cookie: "noskrap_visitor=other" } }),
    new Request(forwarded.url, { headers: { ...Object.fromEntries(forwarded.headers), "x-noskrap-context": token + "x" } }),
  ]) assert.equal(await readContext(altered, config), null);
  assert.equal(await readContext(forwarded, { ...config, secret: "another-secret-with-at-least-32-bytes" }), null);
  now += 30000;
  assert.equal(await readContext(forwarded, config), null);
});

test("challenge uses 303 for form POST and structured 403 for fetch requests", async () => {
  const proxy = createNoSkrapProxy({ secret: SECRET, storage: new MemoryBotStorage(), mode: "enforce", challengePath: "/bot-check", thresholds: { observe: 10, challenge: 20, block: 95 } });
  const form = await proxy(new Request("https://example.test/checkout", { method: "POST", body: "private=form", headers: { "user-agent": "HeadlessChrome", "sec-fetch-mode": "navigate", accept: "text/html" } }));
  assert.equal(form.status, 303);
  for (const method of ["POST", "GET"]) {
    const response = await proxy(new Request("https://example.test/checkout", { method, headers: { "user-agent": "HeadlessChrome", "sec-fetch-mode": "cors" } }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("location"), null);
    assert.ok(((await response.json()).challengeUrl)?.includes("/bot-check?next="));
  }
});

test("recovery bypass is exact and removes client-supplied contexts", async () => {
  const proxy = createNoSkrapProxy({ secret: SECRET, mode: "enforce", protectedRoutes: ["/"], recoveryRoutes: ["/api/pass/"] });
  const init = { method: "POST", headers: { "user-agent": "curl/8", "x-noskrap-context": "forged" } };
  const bypass = await proxy(new Request("https://example.test/api/pass", init));
  assert.equal(bypass.status, 200);
  assert.equal(bypass.headers.get("x-middleware-request-x-noskrap-context"), null);
  assert.equal((await proxy(new Request("https://example.test/api/pass/child", init))).status, 403);
});

test("outage defaults are open in observe and closed in enforce, with explicit override", async () => {
  const storage = new MemoryBotStorage();
  storage.incrementCounter = async () => { throw new Error("offline"); };
  for (const [mode, storageFailureMode, status] of [["observe", undefined, 200], ["enforce", undefined, 503], ["enforce", "open", 200], ["observe", "closed", 503]] as const) {
    const proxy = createNoSkrapProxy({ secret: SECRET, storage, getClientIp: () => "trusted", mode, storageFailureMode });
    assert.equal((await proxy(new Request("https://example.test/"))).status, status);
  }
});

test("telemetry verifier receives capped raw bytes and failed writes return 503", async () => {
  const raw = '{ "interacted": true }';
  const storage = new MemoryBotStorage();
  storage.setVisitor = async () => { throw new Error("offline"); };
  const handler = createNoSkrapTelemetryHandler({ secret: SECRET, storage, verifyTelemetry: (_request, _payload, body) => new TextDecoder().decode(body) === raw });
  assert.equal((await handler(new Request("https://example.test/telemetry", { method: "POST", body: raw }))).status, 503);
  const challenge = createNoSkrapChallengePassHandler({ secret: SECRET, verifyChallenge: () => true });
  const response = await challenge(new Request("https://example.test/pass"));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("verification deadlines cancel work without issuing cookies or writes", async () => {
  let writes = 0;
  let received: AbortSignal | undefined;
  const storage = {
    getVisitor: async () => null,
    setVisitor: async () => { writes++; },
    incrementCounter: async () => 1,
  };
  const stalled = (signal: AbortSignal) => {
    received = signal;
    return new Promise<boolean>(() => {});
  };
  const handlers = [
    createNoSkrapTelemetryHandler({ secret: SECRET, storage, verificationTimeoutMs: 10,
      verifyTelemetry: (_request, _payload, _raw, signal) => stalled(signal) }),
    createNoSkrapChallengePassHandler({ secret: SECRET, verificationTimeoutMs: 10,
      verifyChallenge: (_request, signal) => stalled(signal) }),
  ];
  for (const handler of handlers) {
    const response = await handler(new Request("https://example.test/api/proof", { method: "POST", body: '{"interacted":true}' }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(received?.aborted, true);
  }
  assert.equal(writes, 0);
  const failed = createNoSkrapChallengePassHandler({ secret: SECRET, verifyChallenge: () => { throw new Error("secret provider error"); } });
  const response = await failed(new Request("https://example.test/", { method: "POST" }));
  assert.equal(response.status, 503);
  assert.ok(!(await response.text())?.includes("secret provider error"));
});

test("observer timeout preserves enforcement and cancels stalled logging", async () => {
  const log = console.error;
  console.error = () => {};
  let received: AbortSignal | undefined;
  try {
    const proxy = createNoSkrapProxy({ secret: SECRET, mode: "enforce", onDecisionTimeoutMs: 10,
      thresholds: { observe: 1, challenge: 2, block: 3 },
      onDecision: (_result, _request, signal) => { received = signal; return new Promise<void>(() => {}); } });
    assert.equal((await proxy(new Request("https://example.test/", { headers: { "user-agent": "curl" } }))).status, 403);
    assert.equal(received?.aborted, true);
  } finally { console.error = log; }
});

test("slow telemetry streams are cancelled before verification", async () => {
  let cancelled = false;
  let verified = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const handler = createNoSkrapTelemetryHandler({ secret: SECRET, verificationTimeoutMs: 10,
    verifyTelemetry: () => { verified = true; return true; } });
  const init = { method: "POST", body, duplex: "half" };
  const response = await handler(new Request("https://example.test/", init));
  assert.equal(response.status, 408);
  assert.equal(cancelled, true);
  assert.equal(verified, false);
  for (const value of [0, NaN, Infinity]) {
    assert.throws(() => createNoSkrapTelemetryHandler({ secret: SECRET, verificationTimeoutMs: value, verifyTelemetry: () => true }), new RegExp("verificationTimeoutMs"));
    assert.throws(() => createNoSkrapProxy({ secret: SECRET, onDecisionTimeoutMs: value }), new RegExp("onDecisionTimeoutMs"));
  }
});

test("rewrites score and bind the destination without a second increment", async () => {
  let increments = 0;
  const storage = { getVisitor: async () => null, setVisitor: async () => {},
    incrementCounter: async () => { increments++; return 1; } };
  const config = { secret: SECRET, storage, protectedRoutes: ["/api"], getClientIp: () => "trusted" };
  const request = new Request("https://example.test/public?keep=1", { method: "POST", headers: { host: "example.test" } });
  let observations = 0;
  const proxy = createNoSkrapProxy({ ...config, onDecision: () => { observations++; },
    rewrite: original => new URL(original.url).pathname === "/public"
      ? new URL(`/api/check${new URL(original.url).search}`, original.url) : null });
  const response = await proxy(request);
  assert.equal(response.headers.get("x-middleware-rewrite"), "https://example.test/api/check?keep=1");
  const forwarded = forwardedRequest(request, response);
  const rewritten = new Request(response.headers.get("x-middleware-rewrite")!, { method: "POST", headers: forwarded.headers });
  const secondPass = await proxy(rewritten);
  const result = await getNoSkrapDecision(forwardedRequest(rewritten, secondPass), config);
  assert.equal(observations, 1);
  assert.equal(result.reasons.some(reason => reason.ruleId === "behavior.noRecentInteraction"), true);
  assert.equal(increments, 2); // IP route and new-visitor counters, once each
  const { readContext } = await import("./context.js");
  assert.equal(await readContext(forwarded, config), null);
  assert.equal(await readContext(new Request("https://example.test/unrelated", { method: "POST", headers: forwarded.headers }), config), null);
  await assert.rejects(createNoSkrapProxy({ ...config, rewrite: () => new URL("https://other.test/api") })(request), new RegExp("same-origin"));
});

test("configured context lifetime supports delayed handlers and remains bounded", async () => {
  let now = 1000;
  let increments = 0;
  const config = { secret: SECRET, contextTtlMs: 60_000, now: () => now, getClientIp: () => "trusted",
    storage: { getVisitor: async () => null, setVisitor: async () => {}, incrementCounter: async () => { increments++; return 1; } } };
  const request = new Request("https://example.test/api/check");
  const forwarded = forwardedRequest(request, await createNoSkrapProxy(config)(request));
  now += 31_000;
  await getNoSkrapDecision(forwarded, config);
  assert.equal(increments, 2); // IP route and new-visitor counters, once each
  const { readContext } = await import("./context.js");
  now += 29_000;
  assert.equal(await readContext(forwarded, config), null);
  assert.throws(() => createNoSkrapProxy({ ...config, contextTtlMs: 300_001 }), new RegExp("300000"));
});
