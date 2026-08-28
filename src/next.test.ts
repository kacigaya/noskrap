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
    next: () => new Response(null),
    redirect: (url: URL) => Response.redirect(url),
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
    onDecision: (result) => observations.push(result),
  });

  const response = await proxy(new Request("https://example.test/"));

  expect(response?.status).toBe(200);
  expect(observations).toEqual([
    {
      decision: "allow",
      score: 0,
      reasons: [],
      challengePassed: false,
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
