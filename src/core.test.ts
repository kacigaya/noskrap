import { describe, expect, test } from "bun:test";
import {
  MemoryBotStorage,
  createChallengePassHeaders,
  decisionForScore,
  recordTelemetry,
  scoreRequest,
  signVisitorToken,
  verifyChallengePass,
  verifyVisitorToken,
} from "./core";

const SECRET = "test-secret-with-enough-bytes";

describe("visitor token", () => {
  test("verifies signed payload and rejects tampering", async () => {
    const token = await signVisitorToken(
      { id: "v_test", firstSeen: 1000, lastSeen: 2000, rollingRisk: 12 },
      SECRET,
    );

    expect(await verifyVisitorToken(token, SECRET)).toMatchObject({
      id: "v_test",
    });
    expect(await verifyVisitorToken(`${token}x`, SECRET)).toBeNull();
    expect(
      await verifyVisitorToken(token, ["old-secret", SECRET]),
    ).toMatchObject({ id: "v_test" });
  });
});

describe("memory storage", () => {
  test("expires counters by window", async () => {
    let now = 0;
    const storage = new MemoryBotStorage(() => now);

    expect(await storage.incrementCounter("route", 1)).toBe(1);
    expect(await storage.incrementCounter("route", 1)).toBe(2);
    now = 1001;
    expect(await storage.incrementCounter("route", 1)).toBe(1);
  });

  test("rejects reused nonce before ttl", async () => {
    let now = 0;
    const storage = new MemoryBotStorage(() => now);

    expect(await storage.putNonce("n", 1)).toBe(true);
    expect(await storage.putNonce("n", 1)).toBe(false);
    now = 1001;
    expect(await storage.putNonce("n", 1)).toBe(true);
  });
});

describe("scoring", () => {
  test("maps score bands", () => {
    expect(decisionForScore(0)).toBe("allow");
    expect(decisionForScore(30)).toBe("observe");
    expect(decisionForScore(60)).toBe("challenge");
    expect(decisionForScore(85)).toBe("block");
  });

  test("scores curl-like protected request and sets safe cookie", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    const result = await scoreRequest(
      new Request("https://example.test/api/search", {
        method: "POST",
        headers: { "user-agent": "curl/8.0" },
      }),
      {
        secret: SECRET,
        protectedRoutes: ["/api/search"],
        storage,
        mode: "observe",
      },
    );

    expect(result.decision).toBe("block");
    expect(result.reasons.map((reason) => reason.ruleId)).toContain(
      "browser.automationUa",
    );
    expect(result.reasons.map((reason) => reason.ruleId)).toContain(
      "behavior.noRecentInteraction",
    );
    expect(result.headers.get("set-cookie")).toContain(
      "HttpOnly; Secure; SameSite=Lax; Path=/",
    );
  });

  test("keeps normal browser navigation low risk", async () => {
    const result = await scoreRequest(
      new Request("https://example.test/", {
        headers: {
          accept: "text/html",
          "accept-language": "en-US,en;q=0.9",
          "sec-fetch-mode": "navigate",
          "user-agent": "Mozilla/5.0 Chrome/120 Safari/537.36",
        },
      }),
      { secret: SECRET, storage: new MemoryBotStorage(() => 1000) },
    );

    expect(result.decision).toBe("allow");
    expect(result.score).toBe(0);
  });

  test("adds route burst reason after repeated requests", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    let result;
    let cookie = "";

    for (let index = 0; index < 31; index += 1) {
      result = await scoreRequest(
        new Request("https://example.test/api/search", {
          headers: cookie ? { cookie } : undefined,
        }),
        {
          secret: SECRET,
          protectedRoutes: ["/api/search"],
          storage,
        },
      );
      cookie = result.headers.get("set-cookie")?.split(";")[0] ?? "";
    }

    expect(result?.reasons.map((reason) => reason.ruleId)).toContain(
      "rate.routeBurst",
    );
  });

  test("scores protected post without recent interaction", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    const first = await scoreRequest(new Request("https://example.test/"), {
      secret: SECRET,
      storage,
    });
    const cookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";

    const result = await scoreRequest(
      new Request("https://example.test/api/search", {
        method: "POST",
        headers: { cookie },
      }),
      { secret: SECRET, protectedRoutes: ["/api/search"], storage },
    );

    expect(result.reasons.map((reason) => reason.ruleId)).toContain(
      "behavior.noRecentInteraction",
    );
  });

  test("allows protected post after recent interaction", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    const first = await scoreRequest(new Request("https://example.test/"), {
      secret: SECRET,
      storage,
    });
    const cookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";

    await recordTelemetry(
      new Request("https://example.test/api/noskrap/telemetry", {
        method: "POST",
        headers: { cookie },
      }),
      { secret: SECRET, storage },
      { interacted: true },
    );

    const result = await scoreRequest(
      new Request("https://example.test/api/search", {
        method: "POST",
        headers: { cookie },
      }),
      { secret: SECRET, protectedRoutes: ["/api/search"], storage },
    );

    expect(result.reasons.map((reason) => reason.ruleId)).not.toContain(
      "behavior.noRecentInteraction",
    );
  });

  test("scores protected post after stale interaction", async () => {
    let now = 1000;
    const storage = new MemoryBotStorage(() => now);
    const first = await scoreRequest(new Request("https://example.test/"), {
      secret: SECRET,
      storage,
      now: () => now,
    });
    const cookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";

    await recordTelemetry(
      new Request("https://example.test/api/noskrap/telemetry", {
        method: "POST",
        headers: { cookie },
      }),
      { secret: SECRET, storage, now: () => now },
      { interacted: true },
    );
    now += 10 * 60 * 1000 + 1;

    const result = await scoreRequest(
      new Request("https://example.test/api/search", {
        method: "POST",
        headers: { cookie },
      }),
      {
        secret: SECRET,
        protectedRoutes: ["/api/search"],
        storage,
        now: () => now,
      },
    );

    expect(result.reasons.map((reason) => reason.ruleId)).toContain(
      "behavior.noRecentInteraction",
    );
  });
});

describe("challenge pass", () => {
  test("allows challenge decision with valid pass", async () => {
    let now = 1000;
    const storage = new MemoryBotStorage(() => now);
    const config = {
      secret: SECRET,
      storage,
      now: () => now,
      thresholds: { observe: 0, challenge: 0, block: 101 },
    };
    const first = await scoreRequest(
      new Request("https://example.test/"),
      config,
    );
    const visitorCookie = cookieHeader(first.headers);
    const passHeaders = await createChallengePassHeaders(
      new Request("https://example.test/bot-check", {
        headers: { cookie: visitorCookie },
      }),
      config,
    );
    const cookie = cookieHeader(passHeaders);

    expect(
      await verifyChallengePass(
        new Request("https://example.test/", { headers: { cookie } }),
        config,
      ),
    ).toBe(true);

    const result = await scoreRequest(
      new Request("https://example.test/", { headers: { cookie } }),
      config,
    );

    expect(result.score).toBe(0);
    expect(result.challengePassed).toBe(true);
    expect(result.decision).toBe("allow");
  });

  test("does not allow block decision with valid pass", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    const config = {
      secret: SECRET,
      storage,
      now: () => 1000,
      thresholds: { observe: 0, challenge: 0, block: 30 },
    };
    const first = await scoreRequest(
      new Request("https://example.test/"),
      config,
    );
    const visitorCookie = cookieHeader(first.headers);
    const passHeaders = await createChallengePassHeaders(
      new Request("https://example.test/bot-check", {
        headers: { cookie: visitorCookie },
      }),
      config,
    );
    const cookie = cookieHeader(passHeaders);

    const result = await scoreRequest(
      new Request("https://example.test/api/search", {
        headers: { cookie, "user-agent": "curl/8.0" },
      }),
      config,
    );

    expect(result.challengePassed).toBe(false);
    expect(result.decision).toBe("block");
  });

  test("ignores expired and tampered challenge pass", async () => {
    let now = 1000;
    const storage = new MemoryBotStorage(() => now);
    const config = {
      secret: SECRET,
      storage,
      now: () => now,
      challengeTtlSeconds: 1,
      thresholds: { observe: 0, challenge: 0, block: 101 },
    };
    const first = await scoreRequest(
      new Request("https://example.test/"),
      config,
    );
    const visitorCookie = cookieHeader(first.headers);
    const passHeaders = await createChallengePassHeaders(
      new Request("https://example.test/bot-check", {
        headers: { cookie: visitorCookie },
      }),
      config,
    );
    const cookie = cookieHeader(passHeaders);

    now = 2001;
    expect(
      await verifyChallengePass(
        new Request("https://example.test/", { headers: { cookie } }),
        config,
      ),
    ).toBe(false);

    expect(
      await verifyChallengePass(
        new Request("https://example.test/", {
          headers: { cookie: `${cookie}x` },
        }),
        { ...config, now: () => 1000 },
      ),
    ).toBe(false);
  });
});

function cookieHeader(headers: Headers): string {
  const values =
    (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [headers.get("set-cookie") ?? ""];

  return values
    .flatMap((value) => value.split(/,(?=[^;,]+=)/))
    .map((value) => value.split(";")[0])
    .join("; ");
}
