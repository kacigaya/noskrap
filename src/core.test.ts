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

const SECRET = "test-secret-with-at-least-32-bytes";

describe("visitor token", () => {
  test("verifies signed payload and rejects tampering", async () => {
    const token = await signVisitorToken(
      { id: "v_test" },
      SECRET,
    );

    expect(await verifyVisitorToken(token, SECRET)).toMatchObject({
      id: "v_test",
    });
    expect(await verifyVisitorToken(`${token}x`, SECRET)).toBeNull();
    expect(
      await verifyVisitorToken(token, [
        "old-test-secret-with-at-least-32-bytes",
        SECRET,
      ]),
    ).toMatchObject({ id: "v_test" });
    expect(await verifyVisitorToken(`${token}.extra`, SECRET)).toBeNull();
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

  test("bounds stored visitors", async () => {
    const storage = new MemoryBotStorage(() => 0, 2);
    await storage.setVisitor("a", { id: "a", lastSeen: 0 }, 60);
    await storage.setVisitor("b", { id: "b", lastSeen: 0 }, 60);
    await storage.setVisitor("c", { id: "c", lastSeen: 0 }, 60);

    expect(await storage.getVisitor("a")).toBeNull();
    expect(await storage.getVisitor("b")).not.toBeNull();
    expect(await storage.getVisitor("c")).not.toBeNull();
  });

  test("expires visitors by ttl", async () => {
    let now = 0;
    const storage = new MemoryBotStorage(() => now);
    await storage.setVisitor("a", { id: "a", lastSeen: 0 }, 60);

    now = 60_000;
    expect(await storage.getVisitor("a")).toBeNull();
  });

  test("evicts expired entries before live ones when full", async () => {
    let now = 0;
    const storage = new MemoryBotStorage(() => now, 2);
    await storage.setVisitor("stale", { id: "stale", lastSeen: 0 }, 1);
    await storage.setVisitor("live", { id: "live", lastSeen: 0 }, 60);

    now = 1_000;
    await storage.setVisitor("new", { id: "new", lastSeen: now }, 60);

    expect(await storage.getVisitor("stale")).toBeNull();
    expect(await storage.getVisitor("live")).not.toBeNull();
    expect(await storage.getVisitor("new")).not.toBeNull();
  });

  test("rejects an invalid capacity", () => {
    expect(() => new MemoryBotStorage(Date.now, 0)).toThrow(TypeError);
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

  test("does not treat an invalid cookie as visitor continuity", async () => {
    const result = await scoreRequest(
      new Request("https://example.test/api/search", {
        headers: { cookie: "noskrap_visitor=invalid" },
      }),
      {
        secret: SECRET,
        protectedRoutes: ["/api/search"],
        storage: new MemoryBotStorage(() => 1000),
      },
    );

    expect(result.reasons.map((reason) => reason.ruleId)).toContain(
      "behavior.noCookieContinuity",
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

    for (let index = 0; index < 32; index += 1) {
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

  test("does not share an unknown IP rate bucket", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    let result;

    for (let index = 0; index < 61; index += 1) {
      result = await scoreRequest(
        new Request("https://example.test/search"),
        { secret: SECRET, storage },
      );
    }

    expect(result?.reasons.map((reason) => reason.ruleId)).not.toContain(
      "rate.routeBurst",
    );
  });

  test("uses an explicit trusted IP resolver for rate limits", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    let result;

    for (let index = 0; index < 61; index += 1) {
      result = await scoreRequest(
        new Request("https://example.test/search"),
        {
          secret: SECRET,
          storage,
          getClientIp: () => "203.0.113.1",
        },
      );
    }

    expect(result?.reasons.map((reason) => reason.ruleId)).toContain(
      "rate.routeBurst",
    );
  });

  test("keeps rate buckets separate per client IP", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    let result;

    for (let index = 0; index < 80; index += 1) {
      result = await scoreRequest(new Request("https://example.test/search"), {
        secret: SECRET,
        storage,
        getClientIp: () => (index % 2 ? "203.0.113.1" : "203.0.113.2"),
      });
    }

    expect(result?.reasons.map((reason) => reason.ruleId)).not.toContain(
      "rate.routeBurst",
    );
  });

  test("rejects unsafe configuration", async () => {
    await expect(
      scoreRequest(new Request("https://example.test/"), { secret: "" }),
    ).rejects.toThrow("at least 32 characters");
    await expect(
      scoreRequest(new Request("https://example.test/"), {
        secret: SECRET,
        thresholds: { observe: 60, challenge: 30, block: 85 },
      }),
    ).rejects.toThrow("thresholds");
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
      thresholds: { observe: 0, challenge: 0, block: 100 },
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
    expect(passHeaders).not.toBeNull();
    const cookie = `${visitorCookie}; ${cookieHeader(passHeaders!)}`;

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
    expect(passHeaders).not.toBeNull();
    const cookie = `${visitorCookie}; ${cookieHeader(passHeaders!)}`;

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
      thresholds: { observe: 0, challenge: 0, block: 100 },
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
    expect(passHeaders).not.toBeNull();
    const cookie = `${visitorCookie}; ${cookieHeader(passHeaders!)}`;

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

  test("requires an existing visitor before issuing a pass", async () => {
    expect(
      await createChallengePassHeaders(
        new Request("https://example.test/bot-check"),
        { secret: SECRET },
      ),
    ).toBeNull();
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

describe("scoring regressions", () => {
  test("protects root and trailing-slash prefixes without matching siblings", async () => {
    for (const [route, path, protectedPath] of [
      ["/", "/checkout", true], ["/checkout/", "/checkout", true],
      ["/checkout/", "/checkout/cart", true], ["/checkout", "/checkout/", true],
      ["/checkout", "/checkout-other", false],
    ] as const) {
      const result = await scoreRequest(new Request(`https://example.test${path}`, { method: "POST" }), {
        secret: SECRET, protectedRoutes: [route], storage: new MemoryBotStorage(),
      });
      expect(result.reasons.some(reason => reason.ruleId === "behavior.noCookieContinuity")).toBe(protectedPath);
    }
    await expect(scoreRequest(new Request("https://example.test/"), { secret: SECRET, protectedRoutes: ["checkout"] })).rejects.toThrow("absolute URL paths");
  });

  test("aggregates dynamic child paths and does not allocate cookie-less state", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    let writes = 0;
    const configured = { secret: SECRET, protectedRoutes: ["/api/items"], getClientIp: () => "203.0.113.5", storage: {
      getVisitor: storage.getVisitor.bind(storage), incrementCounter: storage.incrementCounter.bind(storage),
      setVisitor: async () => { writes++; },
    } };
    let result;
    for (let i = 0; i < 61; i++) result = await scoreRequest(new Request(`https://example.test/api/items/${i}`), configured);
    expect(result?.reasons.some(reason => reason.ruleId === "rate.routeBurst")).toBe(true);
    expect(writes).toBe(0);
  });

  test("a delayed scorer cannot overwrite verified telemetry", async () => {
    const memory = new MemoryBotStorage(() => 1000);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const config = { secret: SECRET, now: () => 1000, protectedRoutes: ["/"], storage: {
      getVisitor: memory.getVisitor.bind(memory), setVisitor: memory.setVisitor.bind(memory),
      incrementCounter: async () => { entered(); await released; return 1; },
    } };
    const cookie = `noskrap_visitor=${await signVisitorToken({ id: "v_race" }, SECRET)}`;
    const score = scoreRequest(new Request("https://example.test/checkout", { method: "POST", headers: { cookie } }), config);
    await started;
    try {
      const recorded = await recordTelemetry(new Request("https://example.test/telemetry", { headers: { cookie } }), config, { interacted: true });
      expect(recorded.visitorId).toBe("v_race");
    } finally { release(); }
    await score;
    expect((await memory.getVisitor("v_race"))?.lastInteractionAt).toBe(1000);
    await recordTelemetry(new Request("https://example.test/telemetry", { headers: { cookie } }), config, { interacted: false });
    expect((await memory.getVisitor("v_race"))?.lastInteractionAt).toBe(1000);
  });

  test("memory updates preserve newest timestamps and isolate returned records", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    await storage.setVisitor("v_a", { id: "v_a", lastSeen: 200, lastInteractionAt: 200 }, 600);
    await storage.setVisitor("v_a", { id: "v_a", lastSeen: 100, lastInteractionAt: 100 }, 600);
    const visitor = await storage.getVisitor("v_a");
    expect(visitor).toEqual({ id: "v_a", lastSeen: 200, lastInteractionAt: 200 });
    visitor!.lastInteractionAt = 0;
    expect((await storage.getVisitor("v_a"))?.lastInteractionAt).toBe(200);
  });

  test("storage errors and timeouts mark scoring unavailable", async () => {
    for (const incrementCounter of [async () => { throw new Error("offline"); }, () => new Promise<number>(() => {})]) {
      const result = await scoreRequest(new Request("https://example.test/"), {
        secret: SECRET, storageTimeoutMs: 10, getClientIp: () => "203.0.113.1",
        storage: { getVisitor: async () => null, setVisitor: async () => {}, incrementCounter },
      });
      expect(result.scoringAvailable).toBe(false);
      expect(result.reasons.some(reason => reason.ruleId === "rate.routeBurst")).toBe(false);
    }
  });

  test("Unicode visitor ids round-trip alongside legacy tokens", async () => {
    for (const id of ["用户", "café", "v_🔒"]) {
      const token = await signVisitorToken({ id }, SECRET);
      expect(await verifyVisitorToken(token, SECRET)).toEqual({ id });
    }
    const body = btoa(JSON.stringify({ id: "café" })).replaceAll("=", "");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    const encoded = btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    expect(await verifyVisitorToken(`${body}.${encoded}`, SECRET)).toEqual({ id: "café" });
  });
});

// The stored timestamp 0 is valid; a future timestamp must not lower risk.
test("interaction boundaries and longest protected route buckets", async () => {
  let now = 0;
  const storage = new MemoryBotStorage(() => now);
  const config = { secret: SECRET, storage, now: () => now, protectedRoutes: ["/", "/api/"] };
  const cookie = `noskrap_visitor=${await signVisitorToken({ id: "v_boundaries" }, SECRET)}`;
  const request = new Request("https://example.test/api/update", { method: "POST", headers: { cookie, "sec-fetch-mode": "cors" } });
  await recordTelemetry(request, config, { interacted: true });
  expect((await scoreRequest(request, config)).reasons).toEqual([]);
  now = -1;
  expect((await scoreRequest(request, config)).reasons.some(reason => reason.ruleId === "behavior.noRecentInteraction")).toBe(true);
  now = 600000;
  expect((await scoreRequest(request, config)).reasons.some(reason => reason.ruleId === "behavior.noRecentInteraction")).toBe(true);
  const keys: string[] = [];
  storage.incrementCounter = async key => { keys.push(key); return 1; };
  await scoreRequest(request, config);
  expect(keys).toEqual(["visitor:v_boundaries:/api"]);
});

test("disabled storage rules do not depend on backing services", async () => {
  const fail = async (): Promise<never> => { throw new Error("must not call storage"); };
  const result = await scoreRequest(new Request("https://example.test/checkout", {
    method: "POST", headers: { "sec-fetch-mode": "cors", cookie: `noskrap_visitor=${await signVisitorToken({ id: "v_disabled" }, SECRET)}` },
  }), {
    secret: SECRET, protectedRoutes: ["/"], getClientIp: () => "trusted",
    rules: [{ id: "rate.routeBurst", enabled: false }, { id: "behavior.noRecentInteraction", enabled: false }],
    storage: { getVisitor: fail, setVisitor: fail, incrementCounter: fail },
  });
  expect(result.scoringAvailable).toBe(true);
  expect(result.reasons).toEqual([]);
  await expect(scoreRequest(new Request("https://example.test/"), {
    secret: SECRET, storageTimeoutMs: 2147483648,
  })).rejects.toThrow("2147483647");
});
