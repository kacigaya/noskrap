# API Reference

NoSkrap exports five entrypoints.

## `noskrap/next`

| API | Description |
| --- | --- |
| `createNoSkrapProxy(config)` | Creates a Next.js proxy or middleware function. |
| `getNoSkrapDecision(request, config)` | Reuses verified proxy context, otherwise scores directly. |
| `getNoSkrapPageDecision(pathname, config)` | Reads a signed proxy decision in a Server Component. Throws if context is missing, expired, or mismatched. Never scores again. |
| `createNoSkrapTelemetryHandler(config)` | Requires `verifyTelemetry(request, payload, rawBody)`. |
| `createNoSkrapChallengePassHandler(config)` | Requires `verifyChallenge(request, signal)`. Accepts POST only. |
| `createTurnstileVerifier(options)` | Creates a challenge verifier using `secretKey`, required `expectedHostname`, and optional `expectedAction`. Accepts JSON `{ token }`. |

## `noskrap/core`

| API | Description |
| --- | --- |
| `scoreRequest(request, config)` | Returns a `BotResult`; never writes visitor interaction state. |
| `recordTelemetry(request, config, payload)` | Records verified interaction and returns `{ visitorId, headers }`; does not score. |
| `BotStorageError` | Persistence failure or timeout thrown by `recordTelemetry`. |
| `createChallengePassHeaders(request, config)` | Issues a challenge cookie for an existing signed visitor. |
| `verifyChallengePass(request, config)` | Checks a visitor-bound, expiring challenge cookie. |
| `createTelemetryToken(request, config)` | Signs a telemetry token for the visitor cookie, or returns `null`. |
| `verifyTelemetryToken(request, config, options?)` | Checks the `x-noskrap-telemetry` header against the visitor cookie and the `minAgeMs`/`maxAgeMs` window. |
| `TELEMETRY_TOKEN_HEADER` | The header name, `x-noskrap-telemetry`. |
| `decisionForScore(score, thresholds?)` | Maps a score to a decision. |
| `MemoryBotStorage` | Bounded development/test storage; default when storage is omitted. |
| `signVisitorToken(payload, secret)` | Signs a visitor token, including Unicode IDs. |
| `verifyVisitorToken(token, secrets)` | Verifies a token with one or more secrets. |

## `noskrap/redis`

| API | Description |
| --- | --- |
| `RedisBotStorage(client, options?)` | Shared Redis storage using atomic Lua scripts. |
| `adaptNodeRedis(client)` | Adapts node-redis's `eval(script, { keys, arguments })`. |
| `adaptUpstashRedis(client)` | Adapts Upstash's `eval(script, keys, args)`. |

## `noskrap/crawlers`

`createVerifiedCrawlerVerifier({ getClientIp, resolver? })` creates a Node-only
Googlebot and Bingbot verifier. Set it as `verifyCrawler` in the shared config.
It checks both reverse and forward DNS. See [Detection controls](/docs/api-reference#detection-controls).

## `noskrap/client`

| API | Description |
| --- | --- |
| `showBotDetectedPopup(result, options?)` | Shows a popup for configured decisions. |
| `startNoSkrapBeacon({ token, endpoint? })` | Sends signed interaction telemetry at most every five minutes. Returns a cleanup function. |

## Storage

Use the same shared `BotStorage` and key prefix in the proxy, route handlers and
telemetry. Next.js can bundle them into separate runtimes even on one server;
a module singleton or `MemoryBotStorage` does not share state across those
bundles. Production needs shared Redis, database or platform KV storage.

The memory fallback warns once per runtime. It caps visitor and counter maps at
10,000 entries each by default, checks expiry on reads, and sweeps expired
entries at most once per second when full. Between sweeps, capacity pressure
can evict the oldest inserted live record. Losing interaction state can cause
false positives; losing counters weakens rate limits.

Only verified `interacted: true` telemetry creates an interaction record, with
a 10-minute TTL. When page-view tracking is enabled, the record stays for 20
minutes to reset both page-counter buckets. Interaction still counts for only
10 minutes. False telemetry does not erase or refresh it. Scoring no longer
creates 30-day visitor records. Signed visitor cookies still last 30 days;
a cookie-less request gets an IP counter only when a trusted IP resolver is
configured, and no visitor counter until it returns a valid cookie.

Custom storage must atomically merge `setVisitor` timestamps using the maximum
of existing and supplied `lastSeen` and `lastInteractionAt`. A read followed by
a write is unsafe under concurrent telemetry. `incrementCounter` must atomically
increment and ensure expiry. The built-in stores return a sliding estimate,
which can be fractional. Custom stores should keep the same two-window policy.
Missing visitor records return `null`; outages
must reject rather than silently return an empty record or zero counter.

### Redis

Redis clients need `get` and `eval`, plus Redis permissions for `GET`, `SET`,
`HMGET`, `HSET` and `EXPIRE` inside Lua scripts. ioredis works directly:

```ts
// lib/noskrap.ts; reuse this config in every integration entrypoint.
import { Redis } from "ioredis";
import { RedisBotStorage } from "noskrap/redis";

export const noSkrapConfig = {
  secret: process.env.NOSKRAP_SECRET!,
  protectedRoutes: ["/api/search", "/login", "/checkout"],
  storage: new RedisBotStorage(new Redis(process.env.REDIS_URL!, {
    connectTimeout: 1000, commandTimeout: 1000,
    enableOfflineQueue: false, maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  })),
};
```

Use your installed client; NoSkrap adds no Redis dependency. For other clients:

```ts
import { RedisBotStorage, adaptNodeRedis, adaptUpstashRedis } from "noskrap/redis";

const nodeStorage = new RedisBotStorage(adaptNodeRedis(nodeRedisClient));
const edgeStorage = new RedisBotStorage(adaptUpstashRedis(upstashClient));
```

Next.js 16 `proxy.ts` runs in Node.js and supports TCP clients. Next.js 15
`middleware.ts` defaults to [Edge](https://nextjs.org/docs/15/app/api-reference/file-conventions/middleware#runtime); use an HTTP client such as Upstash there.
Use the same shared service and prefix for Node.js route handlers.

Keys default to `noskrap:`; customize with `{ keyPrefix }`. Counters use
clock-aligned windows and a two-window estimate:
`current + previous * (1 - elapsed / window)`. At a boundary, the previous
bucket still counts. The estimate assumes an even distribution within that
bucket. It is not an exact request log.

Each counter uses one bounded record: a memory entry or a Redis hash. Redis
keeps one key per counter, with a TTL of two window lengths. The script updates
both the counts and expiry atomically. A missing TTL is repaired on increment.
Backward clock movement keeps the older bucket and its full previous count.
Keep instance clocks synchronized.

Version 0.7 uses new Redis counter keys. Existing 0.6 counter keys expire on
their old TTL. Visitor and interaction keys are unchanged. Counters start fresh
when upgrading. No data migration or database flush is required.

## Config

```ts
interface NoSkrapConfig {
  secret: string | string[];
  mode?: "observe" | "enforce";
  protectedRoutes?: string[];
  challengePath?: string;
  challengeTtlSeconds?: number;
  storageTimeoutMs?: number;
  contextTtlMs?: number;
  storageFailureMode?: "open" | "closed";
  getClientIp?: (request: Request) => string | null | undefined;
  storage?: BotStorage;
  thresholds?: { observe: number; challenge: number; block: number };
  rules?: RuleConfig[];
  maxPageViewsWithoutInteraction?: number;
  automationUserAgents?: RegExp[];
  signalsTimeoutMs?: number;
  signals?: (request: Request, signal: AbortSignal) => BotReason[] | Promise<BotReason[]>;
  crawlerTimeoutMs?: number;
  verifyCrawler?: (request: Request, signal: AbortSignal) => boolean | Promise<boolean>;
  now?: () => number;
}
```

Secrets need at least 32 characters. Proxy configuration also accepts exact
`recoveryRoutes`, `rewrite(request)`, `onDecisionTimeoutMs` and
`onDecision(result, request, signal)`. The observation omits visitor
IDs and cookies and includes `scoringAvailable`.

Storage calls in each batch run concurrently with a 1,000 ms deadline by default.
Optional page-view tracking uses a second batch after reading interaction state.
Failure leaves header-derived rules intact and marks `scoringAvailable: false`;
it does not fabricate storage-dependent reasons. The proxy defaults to opening
in observe mode and returning 503 in enforce mode. Set `storageFailureMode`
explicitly to override. `scoreRequest` reports availability without enforcing
that policy; direct callers must handle it. Telemetry persistence failures
return 503 from the supplied handler or throw `BotStorageError` from the core.

Storage methods receive an optional final `AbortSignal`; existing implementations
remain compatible. Pass it to your transport. A deadline or request disconnect
aborts the entire storage batch, and a failed operation cancels its siblings.
`adaptNodeRedis` uses `withCommandOptions({ abortSignal })` when available.
ioredis lacks per-command cancellation; its connection and command timeouts
bound waiting and disabling its offline queue prevents delayed queued writes.
Cancellation cannot undo commands already received by Redis. A timed-out write
may still commit, even with an abortable client. Never disconnect a shared client
to cancel one request.

For node-redis, disable offline queueing and bound connection setup:

```ts
import { createClient } from "redis";
const client = createClient({
  url: process.env.REDIS_URL,
  disableOfflineQueue: true,
  socket: { connectTimeout: 1000, reconnectStrategy: false },
});
client.on("error", error => console.error("Redis connection failed", error.message));
await client.connect(); // Connect once during application startup.
const storage = new RedisBotStorage(adaptNodeRedis(client));
```

Upstash accepts a client factory for operation-specific signals. Reusing one
aborted signal for every request would permanently break the client:

```ts
import { Redis } from "@upstash/redis";
const options = {
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  retry: false as const,
  enableAutoPipelining: false,
};
const makeClient = (signal?: AbortSignal) => new Redis({
  ...options, signal: signal ?? (() => AbortSignal.timeout(1000)),
});
const storage = new RedisBotStorage(adaptUpstashRedis(makeClient(), makeClient));
```

The factory creates a lightweight HTTP client per operation and disables retries
and auto-pipelining so independent deadlines remain isolated. Choose connection
recovery settings for your deployment; these examples fail promptly during an
outage rather than reconnecting indefinitely.

## Results

```ts
interface BotResult {
  decision: "allow" | "observe" | "challenge" | "block";
  score: number;
  reasons: BotReason[];
  visitorId: string;
  challengePassed: boolean;
  scoringAvailable: boolean;
  headers: Headers;
}
interface TelemetryResult {
  visitorId: string;
  headers: Headers;
}
```

## Scoring

Default bands are 0–29 allow, 30–59 observe, 60–84 challenge and 85–100 block.

| Rule | Score | Signal |
| --- | --- | --- |
| `headers.missingBrowserHeaders` | 25 | HTML navigation without `user-agent`, `accept` or `accept-language`. |
| `browser.automationUa` | 30 | User agent of a headless browser or HTTP library, such as `HeadlessChrome`, `curl`, `python-httpx`, `Go-http-client`, `node`, `axios` or `Scrapy`. |
| `headers.missingFetchMetadata` | 25 | User agent claims Chromium 89+, Firefox 90+ or Safari 16.4+, but the request has no `sec-fetch-mode`. |
| `headers.missingClientHints` | 15 | User agent claims Chromium 89+, but the request has no `sec-ch-ua`. CORS preflights and Android WebView before 116 are exempt. |
| `headers.unbrandedChromium` | 10 | User agent claims Chromium 89+, but `sec-ch-ua` names no vendor brand (only `Chromium` and a GREASE brand). Bare Chromium and Vivaldi users match too, so the score is low. |
| `headers.uaClientHintsMismatch` | 15 | Mobile user agent and `sec-ch-ua-platform` disagree. |
| `headers.badFetchMetadata` | 20 | Protected write without `sec-fetch-mode`, or with `sec-fetch-site: none`. |
| `behavior.noCookieContinuity` | 15 | Protected request without a valid visitor cookie. |
| `behavior.noRecentInteraction` | 30 | Protected write without telemetry in the last 10 minutes. |
| `behavior.noPageInteraction` | 30 | More than `maxPageViewsWithoutInteraction` protected HTML GETs without recent interaction. Disabled unless configured. |
| `rate.routeBurst` | 35 | More than 60 requests per trusted IP or 30 per visitor in one window. |
| `behavior.cookieChurn` | 20 | More than 20 requests without a valid visitor cookie from one trusted IP in one window. Catches clients that drop cookies to reset the visitor counter. Needs `getClientIp`. |
| `rate.heavyBurst` | 30 | Three times the `rate.routeBurst` limits. Adds to it, so a heavy burst alone reaches the challenge band. |

Browsers send fetch metadata and Client Hints only to HTTPS and localhost
origins. The two `missing*` header rules run only when the request URL is
HTTPS or localhost. Declared crawlers, such as search engine bots, can match
`headers.missingFetchMetadata`. Disable or rescore the rule if you must keep
their score low. Disabling `rate.routeBurst` also stops `rate.heavyBurst`,
because no counters are kept.

Children share the longest matching protected-route bucket; unprotected paths
share `*`. `/` matches every path. Trailing slashes are ignored, while sibling
prefixes stay separate. This closes dynamic-path limit fragmentation and can
increase scores for traffic previously spread across child paths.

Rules support disabling or rescoring:

```ts
rules: [
  { id: "browser.automationUa", score: 20 },
  { id: "headers.uaClientHintsMismatch", enabled: false },
]
```

## Migration to 0.6.0

- New rules can raise scores for clients without browser headers:
  `headers.missingFetchMetadata`, `headers.missingClientHints`,
  `headers.unbrandedChromium`, `rate.heavyBurst` and `behavior.cookieChurn`.
  Run in observe mode first and tune them with `rules`.
- `browser.automationUa` matches more HTTP libraries and headless tools.
- Signed proxy contexts from 0.5.x are not accepted by 0.6.0 handlers. Deploy
  the proxy and handlers together. Contexts expire after 30 seconds by default.
- Replace telemetry verifiers that trust `sec-fetch-site` with
  `verifyTelemetryToken`. See [Telemetry](/docs/user-guide/telemetry).

## Migration from 0.3.0

- `recordTelemetry` returns `TelemetryResult`, not a scored `BotResult`.
- `getNoSkrapDecision` reuses the proxy policy when its signed context is valid;
  share configuration or use `scoreRequest` for a separate policy.
- Custom storage must merge timestamps atomically; Redis clients now require
  Lua support. Pass node-redis and Upstash through their respective adapters.
- Enforce-mode storage outages now return 503 by default.
- API challenges return 403 JSON; navigational POST challenges redirect with
  303. Applications must explicitly retry the original operation after recovery.
- First cookie-less requests no longer allocate visitor records or counters.
- Protected children now share their route group's counter.

### Callback deadlines and cancellation

`onDecisionTimeoutMs` defaults to 1,000 ms. Observer errors and timeouts are
logged; enforcement still uses the original decision. `verificationTimeoutMs`
defaults to 5,000 ms for challenge and telemetry verification. Provider errors,
timeouts and cancellation return 503 without issuing a pass or recording
interaction. A verifier must return exactly `true`; rejected proofs return 401.
Telemetry body reads have the same deadline and return 408 on failure.

Callbacks receive an `AbortSignal` as their final argument. Pass it to `fetch`
and other cooperative operations. Existing callbacks can omit this argument.
A timeout cannot stop synchronous blocking code or an operation that ignores
cancellation; avoid CPU-heavy work and configure provider transport timeouts.

## Detection controls

### Page reads without interaction

```ts
const noSkrapConfig = {
  secret: process.env.NOSKRAP_SECRET!,
  protectedRoutes: ["/products"],
  maxPageViewsWithoutInteraction: 20,
  rules: [{ id: "behavior.noPageInteraction", score: 60 }],
};
```

This opt-in rule counts protected HTML GETs for visitors with a valid signed
cookie. It adds 30 points by default after more than the configured number of
views in a sliding 10-minute estimate. The example uses 60 points to reach the
default challenge threshold. Set enforce mode and a challenge path to enforce
that decision. API GETs, HEAD requests, and unprotected pages do not count.

Add the client beacon and telemetry handler before enabling this rule. Recent
verified interaction stops the count. After interaction becomes stale, a new
counter starts. Keep the same config in the proxy and telemetry handler.
Disabling `behavior.noPageInteraction` stops its storage reads and writes.
Visitors that discard cookies do not get per-visitor page counters; trusted-IP
rate and cookie-churn rules cover that traffic.

### Custom signals

```ts
const noSkrapConfig = {
  secret: process.env.NOSKRAP_SECRET!,
  signals: async (request: Request, signal: AbortSignal) => {
    const risk = await lookupYourReputationData(request, signal);
    return risk ? [{ ruleId: "custom.reputation", score: 40 }] : [];
  },
};
```

The hook may return at most 32 reasons. Each reason needs a unique ID beginning
with `custom.` and a finite score from 0 to 100. The rest of the ID accepts
letters, digits, dots, underscores, and hyphens, up to 120 characters.
`rules` can rescore or disable these IDs. The final total remains capped at 100.

`signalsTimeoutMs` defaults to 1,000 ms. Errors, invalid results, and timeouts
set `scoringAvailable: false`. The existing failure policy then applies. Pass
the signal to network or database calls. Use server-owned reputation data.
Trust CDN headers only when your ingress removes client-supplied values and
prevents clients from reaching the origin directly.

### Verified search crawlers

```ts
// Node.js only, including Next.js 16 proxy.ts.
import { createVerifiedCrawlerVerifier } from "noskrap/crawlers";

const noSkrapConfig = {
  secret: process.env.NOSKRAP_SECRET!,
  getClientIp: resolveYourTrustedClientIp,
  verifyCrawler: createVerifiedCrawlerVerifier({
    getClientIp: resolveYourTrustedClientIp,
  }),
};
```

The adapter checks declared Googlebot and Bingbot agents. It requires a trusted
IP resolver. It verifies a reverse-DNS suffix of `.googlebot.com` for Googlebot
or `.search.msn.com` for Bingbot, then checks that forward DNS returns the
original address. IPv4 and IPv6 are supported. A declared agent alone does not
verify a crawler. The method follows the official
[Google](https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests)
and [Bing](https://www.bing.com/webmasters/help/how-to-verify-bingbot-3905dc26)
guides.

Verified crawlers skip passive browser-header checks. Rate limits, cookie
continuity, interaction rules, custom signals, and enforcement still apply.
DNS errors leave the normal header checks enabled. Results stay in a bounded
process-local cache: five minutes for success and 30 seconds for failure, with
at most 1,000 entries. The adapter checks at most eight reverse-DNS names.
`crawlerTimeoutMs` defaults to 1,500 ms. Cancellation reaches the DNS resolver.

The DNS adapter is a separate Node-only entrypoint. Next.js 15 Edge middleware
must use its own `verifyCrawler(request, signal)` implementation through a
trusted verification service. Do not import `noskrap/crawlers` into Edge code.
An optional `resolver` factory supports custom DNS implementations.

### Automation user agents

```ts
const noSkrapConfig = {
  secret: process.env.NOSKRAP_SECRET!,
  automationUserAgents: [/MyInternalCrawler/i, /ExampleScraper\//i],
};
```

Patterns extend the built-in automation list. They use the existing
`browser.automationUa` rule. Global and sticky flags do not keep match state
between requests. Use simple expressions because matching runs on every
request. The user-agent value still comes from the client.
