import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MemoryBotStorage,
  TELEMETRY_TOKEN_HEADER,
  createChallengePassHeaders,
  createTelemetryToken,
  decisionForScore,
  recordTelemetry,
  scoreRequest,
  signVisitorToken,
  verifyChallengePass,
  verifyTelemetryToken,
  verifyVisitorToken,
} from "./core.js";

const SECRET = "test-secret-with-at-least-32-bytes";

describe("visitor token", () => {
  test("verifies signed payload and rejects tampering", async () => {
    const token = await signVisitorToken(
      { id: "v_test" },
      SECRET,
    );

    assert.equal((await verifyVisitorToken(token, SECRET))?.id, "v_test");
    assert.equal(await verifyVisitorToken(`${token}x`, SECRET), null);
    assert.equal((await verifyVisitorToken(token, [
        "old-test-secret-with-at-least-32-bytes",
        SECRET,
      ]))?.id, "v_test");
    assert.equal(await verifyVisitorToken(`${token}.extra`, SECRET), null);
  });
});

describe("telemetry token", () => {
  test("binds to the visitor and enforces its age window", async () => {
    let now = 10_000;
    const config = { secret: SECRET, now: () => now };
    const cookie = `noskrap_visitor=${await signVisitorToken({ id: "v_one" }, SECRET)}`;
    const other = `noskrap_visitor=${await signVisitorToken({ id: "v_two" }, SECRET)}`;
    assert.equal(await createTelemetryToken(new Request("https://example.test/"), config), null);
    const token = (await createTelemetryToken(new Request("https://example.test/", { headers: { cookie } }), config))!;
    const verify = (headers: Record<string, string>, options?: { minAgeMs?: number; maxAgeMs?: number }) =>
      verifyTelemetryToken(new Request("https://example.test/t", { method: "POST", headers }), config, options);

    assert.equal(await verify({ cookie, [TELEMETRY_TOKEN_HEADER]: token }), true);
    assert.equal(await verify({ cookie, [TELEMETRY_TOKEN_HEADER]: token }, { minAgeMs: 1000 }), false);
    now -= 1;
    assert.equal(await verify({ cookie, [TELEMETRY_TOKEN_HEADER]: token }), false);
    now += 1001;
    assert.equal(await verify({ cookie, [TELEMETRY_TOKEN_HEADER]: token }, { minAgeMs: 1000 }), true);
    assert.equal(await verify({ cookie: other, [TELEMETRY_TOKEN_HEADER]: token }), false);
    assert.equal(await verify({ cookie }), false);
    // Other signed tokens, such as the visitor cookie itself, are not accepted.
    assert.equal(await verify({ cookie, [TELEMETRY_TOKEN_HEADER]: cookie.split("=")[1] }), false);
    assert.equal(await verify({ cookie, [TELEMETRY_TOKEN_HEADER]: `${token}x` }), false);
    // A telemetry token is not a visitor cookie.
    const scored = await scoreRequest(new Request("https://example.test/api", {
      headers: { cookie: `noskrap_visitor=${token}` },
    }), { ...config, protectedRoutes: ["/api"], storage: new MemoryBotStorage() });
    assert.notEqual(scored.visitorId, "v_one");
    assert.ok((scored.reasons.map(reason => reason.ruleId))?.includes("behavior.noCookieContinuity"));
    now += 10 * 60 * 1000;
    assert.equal(await verify({ cookie, [TELEMETRY_TOKEN_HEADER]: token }), true);
    assert.equal(await verify({ cookie, [TELEMETRY_TOKEN_HEADER]: token }, { maxAgeMs: 10 * 60 * 1000 }), false);
    now += 24 * 60 * 60 * 1000;
    assert.equal(await verify({ cookie, [TELEMETRY_TOKEN_HEADER]: token }), false);
    await assert.rejects(verify({ cookie }, { minAgeMs: 5, maxAgeMs: 5 }), TypeError);
  });
});

describe("memory storage", () => {
  test("expires counters by window", async () => {
    let now = 0;
    const storage = new MemoryBotStorage(() => now);

    assert.equal(await storage.incrementCounter("route", 1), 1);
    assert.equal(await storage.incrementCounter("route", 1), 2);
    now = 1001;
    assert.equal(await storage.incrementCounter("route", 1), 1);
  });

  test("bounds stored visitors", async () => {
    const storage = new MemoryBotStorage(() => 0, 2);
    await storage.setVisitor("a", { id: "a", lastSeen: 0 }, 60);
    await storage.setVisitor("b", { id: "b", lastSeen: 0 }, 60);
    await storage.setVisitor("c", { id: "c", lastSeen: 0 }, 60);

    assert.equal(await storage.getVisitor("a"), null);
    assert.notEqual(await storage.getVisitor("b"), null);
    assert.notEqual(await storage.getVisitor("c"), null);
  });

  test("expires visitors by ttl", async () => {
    let now = 0;
    const storage = new MemoryBotStorage(() => now);
    await storage.setVisitor("a", { id: "a", lastSeen: 0 }, 60);

    now = 60_000;
    assert.equal(await storage.getVisitor("a"), null);
  });

  test("evicts expired entries before live ones when full", async () => {
    let now = 0;
    const storage = new MemoryBotStorage(() => now, 2);
    await storage.setVisitor("stale", { id: "stale", lastSeen: 0 }, 1);
    await storage.setVisitor("live", { id: "live", lastSeen: 0 }, 60);

    now = 1_000;
    await storage.setVisitor("new", { id: "new", lastSeen: now }, 60);

    assert.equal(await storage.getVisitor("stale"), null);
    assert.notEqual(await storage.getVisitor("live"), null);
    assert.notEqual(await storage.getVisitor("new"), null);
  });

  test("rejects an invalid capacity", () => {
    assert.throws(() => new MemoryBotStorage(Date.now, 0), TypeError);
  });
});

describe("scoring", () => {
  test("maps score bands", () => {
    assert.equal(decisionForScore(0), "allow");
    assert.equal(decisionForScore(30), "observe");
    assert.equal(decisionForScore(60), "challenge");
    assert.equal(decisionForScore(85), "block");
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

    assert.equal(result.decision, "block");
    assert.ok((result.reasons.map((reason) => reason.ruleId))?.includes("browser.automationUa"));
    assert.ok((result.reasons.map((reason) => reason.ruleId))?.includes("behavior.noRecentInteraction"));
    assert.ok((result.headers.get("set-cookie"))?.includes("HttpOnly; Secure; SameSite=Lax; Path=/"));
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

    assert.ok((result.reasons.map((reason) => reason.ruleId))?.includes("behavior.noCookieContinuity"));
  });

  test("keeps normal browser navigation low risk", async () => {
    const result = await scoreRequest(
      new Request("https://example.test/", {
        headers: {
          accept: "text/html",
          "accept-language": "en-US,en;q=0.9",
          "sec-ch-ua": '"Chromium";v="120", "Google Chrome";v="120"',
          "sec-fetch-mode": "navigate",
          "user-agent": "Mozilla/5.0 Chrome/120 Safari/537.36",
        },
      }),
      { secret: SECRET, storage: new MemoryBotStorage(() => 1000) },
    );

    assert.equal(result.decision, "allow");
    assert.equal(result.score, 0);
  });

  test("flags HTTP libraries as automation", async () => {
    const config = { secret: SECRET, storage: new MemoryBotStorage(() => 1000) };
    for (const userAgent of ["python-httpx/0.27", "Go-http-client/1.1", "node", "axios/1.7.2", "Scrapy/2.11", "okhttp/4.12"]) {
      const result = await scoreRequest(new Request("https://example.test/", { headers: { "user-agent": userAgent } }), config);
      assert.ok((result.reasons.map(reason => reason.ruleId))?.includes("browser.automationUa"));
    }
    const browser = await scoreRequest(new Request("https://example.test/", {
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
        accept: "text/html", "accept-language": "en", "sec-fetch-mode": "navigate" },
    }), config);
    assert.deepEqual(browser.reasons, []);
  });

  test("flags a modern browser user agent without browser headers", async () => {
    const config = { secret: SECRET, storage: new MemoryBotStorage(() => 1000) };
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    const ids = async (url: string, headers: Record<string, string>) =>
      (await scoreRequest(new Request(url, { headers }), config)).reasons.map(reason => reason.ruleId);

    assert.deepEqual(await ids("https://example.test/", { "user-agent": chrome, accept: "*/*" }), ["headers.missingFetchMetadata", "headers.missingClientHints"]);
    assert.deepEqual(await ids("https://example.test/", {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    }), ["headers.missingFetchMetadata"]);
    // Older browsers and plain HTTP origins cannot send these headers.
    assert.deepEqual(await ids("https://example.test/", { "user-agent": "Mozilla/5.0 Chrome/70.0 Safari/537.36" }), []);
    assert.deepEqual(await ids("https://example.test/", {
      "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Safari/605.1.15",
    }), []);
    assert.deepEqual(await ids("http://example.test/", { "user-agent": chrome }), []);
    assert.deepEqual(await ids("http://127.example.test/", { "user-agent": chrome }), []);
    // Preflights and old Android WebViews cannot send Client Hints.
    assert.deepEqual((await scoreRequest(new Request("https://example.test/", {
      method: "OPTIONS",
      headers: { "user-agent": chrome, "sec-fetch-mode": "cors", "access-control-request-method": "POST" },
    }), config)).reasons, []);
    const webView = (version: number) =>
      `Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${version}.0.0.0 Mobile Safari/537.36`;
    assert.deepEqual(await ids("https://example.test/", { "user-agent": webView(110), "sec-fetch-mode": "cors" }), []);
    assert.deepEqual(await ids("https://example.test/", { "user-agent": webView(120), "sec-fetch-mode": "cors" }), ["headers.missingClientHints"]);
    for (const origin of ["http://localhost:3000/", "http://app.localhost/", "http://127.0.0.2/"]) {
      assert.deepEqual(await ids(origin, { "user-agent": chrome }), ["headers.missingFetchMetadata", "headers.missingClientHints"]);
    }
  });

  test("escalates a heavy burst into the challenge band", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    const config = {
      secret: SECRET, storage, getClientIp: () => "203.0.113.9",
      rules: [{ id: "behavior.cookieChurn", enabled: false }],
    };
    const scores: number[] = [];
    for (let index = 0; index < 181; index += 1) {
      scores.push((await scoreRequest(new Request("https://example.test/search"), config)).score);
    }
    assert.equal(scores[59], 0);
    assert.equal(scores[60], 35);
    assert.equal(scores[179], 35);
    assert.equal(scores[180], 65);
    assert.equal(decisionForScore(scores[180]), "challenge");

    const disabled = await scoreRequest(new Request("https://example.test/search"), {
      ...config, rules: [...config.rules, { id: "rate.heavyBurst", enabled: false }],
    });
    assert.deepEqual(disabled.reasons.map(reason => reason.ruleId), ["rate.routeBurst"]);
  });

  test("flags many new visitors from one trusted IP", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    const config = { secret: SECRET, storage, getClientIp: () => "203.0.113.7" };
    const ids = async (headers?: Record<string, string>) =>
      (await scoreRequest(new Request("https://example.test/", { headers }), config)).reasons.map(reason => reason.ruleId);
    let first;
    for (let index = 0; index < 20; index += 1) first = await ids();
    assert.deepEqual(first, []);
    assert.deepEqual(await ids(), ["behavior.cookieChurn"]);
    // Preflights cannot carry cookies and are not counted.
    const preflight = await scoreRequest(new Request("https://example.test/", {
      method: "OPTIONS", headers: { "access-control-request-method": "POST" },
    }), { ...config, protectedRoutes: ["/"] });
    assert.deepEqual(preflight.reasons.map(reason => reason.ruleId), []);
    // Returning visitors keep their cookie and are not counted.
    const cookie = `noskrap_visitor=${await signVisitorToken({ id: "v_returning" }, SECRET)}`;
    assert.deepEqual(await ids({ cookie }), []);
  });

  test("flags Chromium client hints without a vendor brand", async () => {
    const config = { secret: SECRET, storage: new MemoryBotStorage(() => 1000) };
    const ids = async (brands: string) => (await scoreRequest(new Request("https://example.test/", {
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "sec-fetch-mode": "cors", "sec-ch-ua": brands },
    }), config)).reasons.map(reason => reason.ruleId);
    assert.deepEqual(await ids('"Chromium";v="141", "Not_A Brand";v="8"'), ["headers.unbrandedChromium"]);
    assert.deepEqual(await ids('"Not)A;Brand";v="99", "Chromium";v="141"'), ["headers.unbrandedChromium"]);
    assert.deepEqual(await ids('"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"'), []);
    assert.deepEqual(await ids('"Microsoft Edge";v="141", "Chromium";v="141", "Not_A Brand";v="24"'), []);
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

    assert.ok((result?.reasons.map((reason) => reason.ruleId))?.includes("rate.routeBurst"));
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

    assert.ok(!(result?.reasons.map((reason) => reason.ruleId))?.includes("rate.routeBurst"));
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

    assert.ok((result?.reasons.map((reason) => reason.ruleId))?.includes("rate.routeBurst"));
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

    assert.ok(!(result?.reasons.map((reason) => reason.ruleId))?.includes("rate.routeBurst"));
  });

  test("rejects unsafe configuration", async () => {
    await assert.rejects(scoreRequest(new Request("https://example.test/"), { secret: "" }), new RegExp("at least 32 characters"));
    await assert.rejects(scoreRequest(new Request("https://example.test/"), {
        secret: SECRET,
        thresholds: { observe: 60, challenge: 30, block: 85 },
      }), new RegExp("thresholds"));
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

    assert.ok((result.reasons.map((reason) => reason.ruleId))?.includes("behavior.noRecentInteraction"));
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

    assert.ok(!(result.reasons.map((reason) => reason.ruleId))?.includes("behavior.noRecentInteraction"));
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

    assert.ok((result.reasons.map((reason) => reason.ruleId))?.includes("behavior.noRecentInteraction"));
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
    assert.notEqual(passHeaders, null);
    const cookie = `${visitorCookie}; ${cookieHeader(passHeaders!)}`;

    assert.equal(await verifyChallengePass(
        new Request("https://example.test/", { headers: { cookie } }),
        config,
      ), true);

    const result = await scoreRequest(
      new Request("https://example.test/", { headers: { cookie } }),
      config,
    );

    assert.equal(result.score, 0);
    assert.equal(result.challengePassed, true);
    assert.equal(result.decision, "allow");
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
    assert.notEqual(passHeaders, null);
    const cookie = `${visitorCookie}; ${cookieHeader(passHeaders!)}`;

    const result = await scoreRequest(
      new Request("https://example.test/api/search", {
        headers: { cookie, "user-agent": "curl/8.0" },
      }),
      config,
    );

    assert.equal(result.challengePassed, false);
    assert.equal(result.decision, "block");
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
    assert.notEqual(passHeaders, null);
    const cookie = `${visitorCookie}; ${cookieHeader(passHeaders!)}`;

    now = 2001;
    assert.equal(await verifyChallengePass(
        new Request("https://example.test/", { headers: { cookie } }),
        config,
      ), false);

    assert.equal(await verifyChallengePass(
        new Request("https://example.test/", {
          headers: { cookie: `${cookie}x` },
        }),
        { ...config, now: () => 1000 },
      ), false);
  });

  test("requires an existing visitor before issuing a pass", async () => {
    assert.equal(await createChallengePassHeaders(
        new Request("https://example.test/bot-check"),
        { secret: SECRET },
      ), null);
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
      assert.equal(result.reasons.some(reason => reason.ruleId === "behavior.noCookieContinuity"), protectedPath);
    }
    await assert.rejects(scoreRequest(new Request("https://example.test/"), { secret: SECRET, protectedRoutes: ["checkout"] }), new RegExp("absolute URL paths"));
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
    assert.equal(result?.reasons.some(reason => reason.ruleId === "rate.routeBurst"), true);
    assert.equal(writes, 0);
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
      assert.equal(recorded.visitorId, "v_race");
    } finally { release(); }
    await score;
    assert.equal((await memory.getVisitor("v_race"))?.lastInteractionAt, 1000);
    await recordTelemetry(new Request("https://example.test/telemetry", { headers: { cookie } }), config, { interacted: false });
    assert.equal((await memory.getVisitor("v_race"))?.lastInteractionAt, 1000);
  });

  test("memory updates preserve newest timestamps and isolate returned records", async () => {
    const storage = new MemoryBotStorage(() => 1000);
    await storage.setVisitor("v_a", { id: "v_a", lastSeen: 200, lastInteractionAt: 200 }, 600);
    await storage.setVisitor("v_a", { id: "v_a", lastSeen: 100, lastInteractionAt: 100 }, 600);
    const visitor = await storage.getVisitor("v_a");
    assert.deepEqual(visitor, { id: "v_a", lastSeen: 200, lastInteractionAt: 200 });
    visitor!.lastInteractionAt = 0;
    assert.equal((await storage.getVisitor("v_a"))?.lastInteractionAt, 200);
  });

  test("storage errors and timeouts mark scoring unavailable", async () => {
    for (const incrementCounter of [async () => { throw new Error("offline"); }, () => new Promise<number>(() => {})]) {
      const result = await scoreRequest(new Request("https://example.test/"), {
        secret: SECRET, storageTimeoutMs: 10, getClientIp: () => "203.0.113.1",
        storage: { getVisitor: async () => null, setVisitor: async () => {}, incrementCounter },
      });
      assert.equal(result.scoringAvailable, false);
      assert.equal(result.reasons.some(reason => reason.ruleId === "rate.routeBurst"), false);
    }
  });

  test("Unicode visitor ids round-trip alongside legacy tokens", async () => {
    for (const id of ["用户", "café", "v_🔒"]) {
      const token = await signVisitorToken({ id }, SECRET);
      assert.deepEqual(await verifyVisitorToken(token, SECRET), { id });
    }
    const body = btoa(JSON.stringify({ id: "café" })).replaceAll("=", "");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    const encoded = btoa(String.fromCharCode(...signature)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    assert.deepEqual(await verifyVisitorToken(`${body}.${encoded}`, SECRET), { id: "café" });
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
  assert.deepEqual((await scoreRequest(request, config)).reasons, []);
  now = -1;
  assert.equal((await scoreRequest(request, config)).reasons.some(reason => reason.ruleId === "behavior.noRecentInteraction"), true);
  now = 600000;
  assert.equal((await scoreRequest(request, config)).reasons.some(reason => reason.ruleId === "behavior.noRecentInteraction"), true);
  const keys: string[] = [];
  storage.incrementCounter = async key => { keys.push(key); return 1; };
  await scoreRequest(request, config);
  assert.deepEqual(keys, ["visitor:v_boundaries:/api"]);
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
  assert.equal(result.scoringAvailable, true);
  assert.deepEqual(result.reasons, []);
  await assert.rejects(scoreRequest(new Request("https://example.test/"), {
    secret: SECRET, storageTimeoutMs: 2147483648,
  }), new RegExp("2147483647"));
});

test("storage receives request cancellation and deadline signals", async () => {
  let received: AbortSignal | undefined;
  const config = {
    secret: "test-secret-with-at-least-32-bytes", storageTimeoutMs: 10,
    getClientIp: () => "127.0.0.1",
    storage: {
      getVisitor: async () => null,
      setVisitor: async () => {},
      incrementCounter: (_key: string, _window: number, signal?: AbortSignal) => {
        received = signal;
        return new Promise<number>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    },
  };
  assert.equal((await scoreRequest(new Request("https://example.test/"), config)).scoringAvailable, false);
  assert.equal(received?.aborted, true);
  const parent = new AbortController();
  const pending = scoreRequest(new Request("https://example.test/", { signal: parent.signal }), { ...config, storageTimeoutMs: 1000 });
  parent.abort();
  assert.equal((await pending).scoringAvailable, false);
});
