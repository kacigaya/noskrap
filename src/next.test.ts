import { expect, mock, test } from "bun:test";
import { MemoryBotStorage } from "./core";
import {
  createNoSkrapChallengePassHandler,
  createNoSkrapProxy,
  createNoSkrapTelemetryHandler,
  getNoSkrapDecision,
} from "./next";

const SECRET = "test-secret-with-at-least-32-bytes";

mock.module("next/server", () => ({
  NextResponse: {
    next: (init?: { request?: { headers?: Headers } }) => {
      const headers = new Headers();
      if (init?.request?.headers) {
        headers.set("x-middleware-override-headers", Array.from(init.request.headers.keys()).join(","));
        init.request.headers.forEach((value, key) => headers.set(`x-middleware-request-${key}`, value));
      }
      return new Response(null, { headers });
    },
    redirect: (url: URL, init?: ResponseInit) => Response.redirect(url, init?.status ?? 307),
  },
}));

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

  expect(result.decision).toBe("allow");
  expect(result.headers.get("set-cookie")).toContain("noskrap_visitor=");
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

  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("noskrap_visitor=");
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

  expect(response.status).toBe(200);
  expect(cookie).toContain("noskrap_challenge=");
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

  expect(
    (
      await telemetry(
        new Request("https://example.test/api/noskrap/telemetry", {
          method: "POST",
          body: JSON.stringify({ interacted: true }),
        }),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await challenge(
        new Request("https://example.test/api/noskrap/challenge-pass", {
          method: "POST",
        }),
      )
    ).status,
  ).toBe(401);
});

test("proxy reports observed decisions", async () => {
  const observations: object[] = [];
  const proxy = createNoSkrapProxy({
    secret: SECRET,
    onDecision: (result) => { observations.push(result); },
  });

  const response = await proxy(new Request("https://example.test/"));

  expect(response?.status).toBe(200);
  expect(observations).toEqual([
    {
      decision: "allow",
      score: 0,
      reasons: [],
      challengePassed: false,
      scoringAvailable: true,
    },
  ]);
  expect("headers" in observations[0]!).toBe(false);
  expect(response?.headers.get("set-cookie")).toContain("noskrap_visitor=");
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

  expect(response?.status).toBe(403);
  expect(response?.headers.get("set-cookie")).toContain("noskrap_visitor=");
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

  expect(response?.status).toBe(200);
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

  expect(response.status).toBe(307);
  expect(new URL(response!.headers.get("location")!).pathname).toBe(
    "/bot-check",
  );
  expect(response?.headers.get("set-cookie")).toContain("noskrap_visitor=");
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

  expect(observations[0]?.decision).toBe("challenge");
  expect(response?.status).toBe(200);
  expect(response?.headers.get("location")).toBeNull();
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
  expect(cookie).toContain("noskrap_visitor=");
  expect(cookie).not.toContain("noskrap_visitor=invalid");
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

  expect(cookie).toContain("noskrap_visitor=");
  expect(second?.headers.get("set-cookie")?.split(";")[0]).toBe(cookie);
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

  expect(response?.status).toBe(200);
  expect(response?.headers.get("location")).toBeNull();
  expect(response?.headers.get("set-cookie")).toContain("noskrap_visitor=");
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

  expect(response?.status).toBe(403);
});

function challengeRedirectNext(response: Response | undefined): string {
  const location = response?.headers.get("location");
  expect(location).not.toBeNull();
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

  expect(challengeRedirectNext(response)).toBe("/api/search?q=foo");
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

  expect(next).toBe("/evil.com/x");
  expect(new URL(next, "https://example.test").origin).toBe(
    "https://example.test",
  );
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

  expect(request.headers.get("content-length")).toBeNull();

  const handler = createNoSkrapTelemetryHandler({
    secret: SECRET,
    verifyTelemetry: () => true,
  });

  expect((await handler(request)).status).toBe(413);
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

  expect(response.status).toBe(413);
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

  expect(response.status).toBe(400);
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
  expect(increments).toBe(1);
  expect(result.score).toBe(15);
  expect(result.headers.get("set-cookie")).toBe(response.headers.get("set-cookie"));
  expect(forwarded.headers.get("cookie")).toContain("session=keep");
});

test("contexts reject tampering, changed URL/method/cookie, expiry and wrong secrets", async () => {
  let now = 1000;
  const config = { secret: SECRET, storage: new MemoryBotStorage(), now: () => now };
  const request = new Request("https://example.test/api/check?long=" + "x".repeat(20000));
  const response = await createNoSkrapProxy(config)(request);
  const forwarded = forwardedRequest(request, response);
  const token = forwarded.headers.get("x-noskrap-context")!;
  expect(token.length).toBeLessThan(8192);
  const { readContext } = await import("./context");
  expect(await readContext(forwarded, config)).not.toBeNull();
  for (const altered of [
    new Request("https://example.test/other", { headers: forwarded.headers }),
    new Request(forwarded.url, { method: "POST", headers: forwarded.headers }),
    new Request(forwarded.url, { headers: { "x-noskrap-context": token, cookie: "noskrap_visitor=other" } }),
    new Request(forwarded.url, { headers: { ...Object.fromEntries(forwarded.headers), "x-noskrap-context": token + "x" } }),
  ]) expect(await readContext(altered, config)).toBeNull();
  expect(await readContext(forwarded, { ...config, secret: "another-secret-with-at-least-32-bytes" })).toBeNull();
  now += 30000;
  expect(await readContext(forwarded, config)).toBeNull();
});

test("challenge uses 303 for form POST and structured 403 for fetch requests", async () => {
  const proxy = createNoSkrapProxy({ secret: SECRET, storage: new MemoryBotStorage(), mode: "enforce", challengePath: "/bot-check", thresholds: { observe: 10, challenge: 20, block: 95 } });
  const form = await proxy(new Request("https://example.test/checkout", { method: "POST", body: "private=form", headers: { "user-agent": "HeadlessChrome", "sec-fetch-mode": "navigate", accept: "text/html" } }));
  expect(form.status).toBe(303);
  for (const method of ["POST", "GET"]) {
    const response = await proxy(new Request("https://example.test/checkout", { method, headers: { "user-agent": "HeadlessChrome", "sec-fetch-mode": "cors" } }));
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect((await response.json()).challengeUrl).toContain("/bot-check?next=");
  }
});

test("recovery bypass is exact and removes client-supplied contexts", async () => {
  const proxy = createNoSkrapProxy({ secret: SECRET, mode: "enforce", protectedRoutes: ["/"], recoveryRoutes: ["/api/pass/"] });
  const init = { method: "POST", headers: { "user-agent": "curl/8", "x-noskrap-context": "forged" } };
  const bypass = await proxy(new Request("https://example.test/api/pass", init));
  expect(bypass.status).toBe(200);
  expect(bypass.headers.get("x-middleware-request-x-noskrap-context")).toBeNull();
  expect((await proxy(new Request("https://example.test/api/pass/child", init))).status).toBe(403);
});

test("outage defaults are open in observe and closed in enforce, with explicit override", async () => {
  const storage = new MemoryBotStorage();
  storage.incrementCounter = async () => { throw new Error("offline"); };
  for (const [mode, storageFailureMode, status] of [["observe", undefined, 200], ["enforce", undefined, 503], ["enforce", "open", 200], ["observe", "closed", 503]] as const) {
    const proxy = createNoSkrapProxy({ secret: SECRET, storage, getClientIp: () => "trusted", mode, storageFailureMode });
    expect((await proxy(new Request("https://example.test/"))).status).toBe(status);
  }
});

test("telemetry verifier receives capped raw bytes and failed writes return 503", async () => {
  const raw = '{ "interacted": true }';
  const storage = new MemoryBotStorage();
  storage.setVisitor = async () => { throw new Error("offline"); };
  const handler = createNoSkrapTelemetryHandler({ secret: SECRET, storage, verifyTelemetry: (_request, _payload, body) => new TextDecoder().decode(body) === raw });
  expect((await handler(new Request("https://example.test/telemetry", { method: "POST", body: raw }))).status).toBe(503);
  const challenge = createNoSkrapChallengePassHandler({ secret: SECRET, verifyChallenge: () => true });
  const response = await challenge(new Request("https://example.test/pass"));
  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("POST");
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
    expect(response.status).toBe(503);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(received?.aborted).toBe(true);
  }
  expect(writes).toBe(0);
  const failed = createNoSkrapChallengePassHandler({ secret: SECRET, verifyChallenge: () => { throw new Error("secret provider error"); } });
  const response = await failed(new Request("https://example.test/", { method: "POST" }));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret provider error");
});

test("observer timeout preserves enforcement and cancels stalled logging", async () => {
  const log = console.error;
  console.error = () => {};
  let received: AbortSignal | undefined;
  try {
    const proxy = createNoSkrapProxy({ secret: SECRET, mode: "enforce", onDecisionTimeoutMs: 10,
      thresholds: { observe: 1, challenge: 2, block: 3 },
      onDecision: (_result, _request, signal) => { received = signal; return new Promise<void>(() => {}); } });
    expect((await proxy(new Request("https://example.test/", { headers: { "user-agent": "curl" } }))).status).toBe(403);
    expect(received?.aborted).toBe(true);
  } finally { console.error = log; }
});

test("slow telemetry streams are cancelled before verification", async () => {
  let cancelled = false;
  let verified = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const handler = createNoSkrapTelemetryHandler({ secret: SECRET, verificationTimeoutMs: 10,
    verifyTelemetry: () => { verified = true; return true; } });
  const response = await handler(new Request("https://example.test/", { method: "POST", body }));
  expect(response.status).toBe(408);
  expect(cancelled).toBe(true);
  expect(verified).toBe(false);
  for (const value of [0, NaN, Infinity]) {
    expect(() => createNoSkrapTelemetryHandler({ secret: SECRET, verificationTimeoutMs: value, verifyTelemetry: () => true })).toThrow("verificationTimeoutMs");
    expect(() => createNoSkrapProxy({ secret: SECRET, onDecisionTimeoutMs: value })).toThrow("onDecisionTimeoutMs");
  }
});
