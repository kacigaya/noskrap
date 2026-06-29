import { describe, expect, test } from "bun:test";
import {
  MemoryBotStorage,
  decisionForScore,
  scoreRequest,
  signVisitorToken,
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

    expect(result.decision).toBe("challenge");
    expect(result.reasons.map((reason) => reason.ruleId)).toContain(
      "browser.automationUa",
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
});
