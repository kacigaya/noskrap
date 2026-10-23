import { afterEach, expect, test } from "bun:test";
import { MemoryBotStorage, scoreRequest } from "./core.js";
import { createNoSkrapChallengePassHandler, createTurnstileVerifier } from "./next.js";

const originalFetch = globalThis.fetch;
function setFetch(implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(implementation, { preconnect: originalFetch.preconnect });
}
afterEach(() => { globalThis.fetch = originalFetch; });
const options = { secretKey: "test-provider-secret", expectedHostname: "example.test", expectedAction: "noskrap" };
const signal = () => new AbortController().signal;
const submission = (body = JSON.stringify({ token: "widget-token" }), headers?: HeadersInit) =>
  new Request("https://example.test/pass", { method: "POST", body, headers });

test("Turnstile verifies the token with the fixed provider and expected context", async () => {
  const parentSignal = signal();
  let calls = 0;
  setFetch(async (input, init) => {
    calls++;
    expect(input).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBe(parentSignal);
    expect(init?.redirect).toBe("error");
    expect(String(init?.body)).toBe("secret=test-provider-secret&response=widget-token");
    return Response.json({ success: true, hostname: "example.test", action: "noskrap" });
  });
  expect(await createTurnstileVerifier(options)(submission(undefined, {
    "x-forwarded-for": "attacker-controlled", host: "other.test",
  }), parentSignal)).toBe(true);
  expect(calls).toBe(1);
});

test("Turnstile rejects false, malformed, mismatched, expired, and replayed results", async () => {
  for (const result of [
    null, [], { success: "true", hostname: "example.test", action: "noskrap" },
    { success: true, hostname: "other.test", action: "noskrap" },
    { success: true, hostname: "example.test", action: "login" },
    { success: true, hostname: "example.test" },
    { success: false, "error-codes": ["timeout-or-duplicate"] },
  ]) {
    setFetch(async () => Response.json(result));
    expect(await createTurnstileVerifier(options)(submission(), signal())).toBe(false);
  }
  setFetch(async () => Response.json({ success: true, hostname: "example.test" }));
  expect(await createTurnstileVerifier({ ...options, expectedAction: undefined })(submission(), signal())).toBe(true);
  expect(await createTurnstileVerifier({ ...options, expectedHostname: "EXAMPLE.TEST", expectedAction: undefined })(submission(), signal())).toBe(true);
});

test("Turnstile rejects invalid and oversized submissions before contacting the provider", async () => {
  let calls = 0;
  setFetch(async () => { calls++; throw new Error("must not fetch"); });
  for (const body of ["bad JSON", "null", "[]", "{}", '{"token":false}',
    JSON.stringify({ token: " " }), JSON.stringify({ token: "x".repeat(2049) }), "x".repeat(4097)]) {
    expect(await createTurnstileVerifier(options)(submission(body), signal())).toBe(false);
  }
  expect(await createTurnstileVerifier(options)(submission(undefined, { "content-length": "4097" }), signal())).toBe(false);
  expect(await createTurnstileVerifier(options)(new Request("https://example.test/pass"), signal())).toBe(false);
  expect(calls).toBe(0);
});

test("Turnstile cancels oversized streams", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4097)); },
    cancel() { cancelled = true; },
  });
  const init = { method: "POST", body, duplex: "half" };
  const request = new Request("https://example.test/pass", init);
  expect(await createTurnstileVerifier(options)(request, signal())).toBe(false);
  expect(cancelled).toBe(true);
});

test("Turnstile handler issues a visitor-bound pass only after provider success", async () => {
  const config = { secret: "test-secret-with-at-least-32-bytes", storage: new MemoryBotStorage() };
  const visitor = await scoreRequest(new Request("https://example.test/"), config);
  const cookie = visitor.headers.get("set-cookie")!.split(";")[0];
  const handler = createNoSkrapChallengePassHandler({ ...config, verifyChallenge: createTurnstileVerifier(options) });
  setFetch(async () => Response.json({ success: true, hostname: "example.test", action: "noskrap" }));
  const passed = await handler(submission(undefined, { cookie }));
  expect(passed.status).toBe(200);
  expect(passed.headers.get("set-cookie")).toContain("noskrap_challenge=");
  expect((await handler(submission())).status).toBe(401);
  setFetch(async () => Response.json({ success: false }));
  const rejected = await handler(submission(undefined, { cookie }));
  expect(rejected.status).toBe(401);
  expect(rejected.headers.get("set-cookie")).toBeNull();
});

test("Turnstile provider failures and timeouts return 503 without a pass", async () => {
  const handler = createNoSkrapChallengePassHandler({
    secret: "test-secret-with-at-least-32-bytes", verificationTimeoutMs: 20,
    verifyChallenge: createTurnstileVerifier(options),
  });
  for (const provider of [
    async () => new Response("unavailable", { status: 503 }),
    async () => new Response("bad JSON"),
    async () => { throw new Error("network error"); },
    async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  ]) {
    setFetch(provider);
    const response = await handler(submission());
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});

test("Turnstile validates configuration at setup", () => {
  for (const invalid of [
    { secretKey: "" }, { expectedHostname: "https://example.test" },
    { expectedHostname: "example.test:443" }, { expectedHostname: "" },
    { expectedAction: "bad action" }, { expectedAction: "x".repeat(33) },
  ]) expect(() => createTurnstileVerifier({ ...options, ...invalid })).toThrow(TypeError);
});
