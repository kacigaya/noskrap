import { expect, test } from "bun:test";
import {
  createNoSkrapChallengePassHandler,
  createNoSkrapTelemetryHandler,
  getNoSkrapDecision,
} from "./next";

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
    { secret: "test-secret-with-enough-bytes" },
  );

  expect(result.decision).toBe("allow");
  expect(result.headers.get("set-cookie")).toContain("noskrap_visitor=");
});

test("telemetry handler records interaction and returns cookie", async () => {
  const handler = createNoSkrapTelemetryHandler({
    secret: "test-secret-with-enough-bytes",
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
    secret: "test-secret-with-enough-bytes",
  });
  const response = await handler(
    new Request("https://example.test/api/noskrap/challenge-pass", {
      method: "POST",
    }),
  );
  const cookie = response.headers.get("set-cookie");

  expect(response.status).toBe(200);
  expect(cookie).toContain("noskrap_visitor=");
  expect(cookie).toContain("noskrap_challenge=");
});
