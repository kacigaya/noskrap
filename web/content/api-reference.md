# API Reference

NoSkrap exports four entrypoints.

## `noskrap/next`

| API | Description |
| --- | --- |
| `createNoSkrapProxy(config)` | Creates a Next.js proxy or middleware function. |
| `getNoSkrapDecision(request, config)` | Reuses verified proxy context, otherwise scores directly. |
| `createNoSkrapTelemetryHandler(config)` | Requires `verifyTelemetry(request, payload, rawBody)`. |
| `createNoSkrapChallengePassHandler(config)` | Requires `verifyChallenge(request)`. Accepts POST only. |

## `noskrap/core`

| API | Description |
| --- | --- |
| `scoreRequest(request, config)` | Returns a `BotResult`; never writes visitor interaction state. |
| `recordTelemetry(request, config, payload)` | Records verified interaction and returns `{ visitorId, headers }`; does not score. |
| `BotStorageError` | Persistence failure or timeout thrown by `recordTelemetry`. |
| `createChallengePassHeaders(request, config)` | Issues a challenge cookie for an existing signed visitor. |
| `verifyChallengePass(request, config)` | Checks a visitor-bound, expiring challenge cookie. |
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

## `noskrap/client`

`showBotDetectedPopup(result, options?)` shows a popup for configured decisions.

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
a 10-minute TTL. False telemetry does not erase or refresh it. Scoring no longer
creates 30-day visitor records. Signed visitor cookies still last 30 days;
a cookie-less request gets an IP counter only when a trusted IP resolver is
configured, and no visitor counter until it returns a valid cookie.

Custom storage must atomically merge `setVisitor` timestamps using the maximum
of existing and supplied `lastSeen` and `lastInteractionAt`. A read followed by
a write is unsafe under concurrent telemetry. `incrementCounter` must atomically
increment and ensure expiry. Missing visitor records return `null`; outages
must reject rather than silently return an empty record or zero counter.

### Redis

Redis clients need `get` and `eval`, plus Redis permissions for `GET`, `SET`,
`INCR`, `TTL` and `EXPIRE` inside Lua scripts. ioredis works directly:

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

Keys default to `noskrap:`; customize with `{ keyPrefix }`. Counter buckets are
clock-aligned 60-second windows. A boundary resets the count, so a burst can
span two windows. Keep instance clocks synchronized. Each write and expiry is
atomic; legacy counter keys without TTL are repaired on the next increment.

## Config

```ts
interface NoSkrapConfig {
  secret: string | string[];
  mode?: "observe" | "enforce";
  protectedRoutes?: string[];
  challengePath?: string;
  challengeTtlSeconds?: number;
  storageTimeoutMs?: number;
  storageFailureMode?: "open" | "closed";
  getClientIp?: (request: Request) => string | null | undefined;
  storage?: BotStorage;
  thresholds?: { observe: number; challenge: number; block: number };
  rules?: RuleConfig[];
  now?: () => number;
}
```

Secrets need at least 32 characters. Proxy configuration also accepts exact
`recoveryRoutes` and `onDecision(result, request)`. The observation omits visitor
IDs and cookies and includes `scoringAvailable`.

Storage calls run concurrently and have a 1,000 ms total deadline by default.
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
Signals cover missing HTML browser headers, automation user agents, Client
Hints mismatch, weak fetch metadata, missing signed cookie continuity, protected
writes without recent interaction, and bursts per visitor or trusted IP.

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
