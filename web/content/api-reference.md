# API Reference

NoSkrap exports three entrypoints.

## `noskrap/next`

| API | Description |
| --- | --- |
| `createNoSkrapProxy(config)` | Creates a Next.js proxy function. |
| `getNoSkrapDecision(request, config)` | Returns the core scoring result. |
| `createNoSkrapTelemetryHandler(config)` | Creates a telemetry handler requiring `verifyTelemetry`. |
| `createNoSkrapChallengePassHandler(config)` | Creates a pass handler requiring `verifyChallenge`. |

## `noskrap/core`

| API | Description |
| --- | --- |
| `scoreRequest(request, config)` | Scores a request and returns a `BotResult`. |
| `recordTelemetry(request, config, payload)` | Scores and records coarse interaction state. |
| `createChallengePassHeaders(request, config)` | Creates a challenge pass cookie for an existing signed visitor. |
| `verifyChallengePass(request, config)` | Checks a signed challenge pass cookie. |
| `decisionForScore(score, thresholds?)` | Maps a numeric score to a decision. |
| `MemoryBotStorage` | Process-local storage for development and tests. Used implicitly when `storage` is omitted. |
| `signVisitorToken(payload, secret)` | Signs a visitor token. |
| `verifyVisitorToken(token, secrets)` | Verifies a visitor token with one or more secrets. |

## `noskrap/client`

| API | Description |
| --- | --- |
| `showBotDetectedPopup(result, options?)` | Shows a popup for configured decisions. |

## Core example

```ts
import { MemoryBotStorage, scoreRequest } from "noskrap/core";

const result = await scoreRequest(request, {
  secret: process.env.NOSKRAP_SECRET!,
  // Process-local. See Storage below before using this in production.
  storage: new MemoryBotStorage(),
  protectedRoutes: ["/api/search"],
});

console.log(result.decision, result.score, result.reasons);
```

## Storage

`scoreRequest` and `recordTelemetry` keep visitor state and route counters in
the `BotStorage` you pass as `storage`. Omit it and both fall back to one shared
`MemoryBotStorage` instance, logging a warning the first time they do.

That fallback holds everything in the current process. It suits local
development, tests, and a single long-lived instance. On serverless, edge, or
any horizontally scaled deployment, each instance starts with an empty store,
and the two rules that read stored state degrade without failing:

- `rate.routeBurst` counts requests per IP and per visitor inside a 60 second
  window. Split across instances, each counter sees a fraction of the traffic,
  so the effective limit rises with the instance count.
- `behavior.noRecentInteraction` reads the last verified interaction timestamp.
  A visitor who interacted on one instance looks inactive on the next.

Neither rule reports an error when this happens; the scores simply come out
lower than they should.

The fallback is also bounded. `MemoryBotStorage` holds 10,000 visitors by
default and evicts the oldest entry once it is full, so a client that sends
enough cookie-less requests can push real visitors out of the store. Those
visitors keep their signed cookie, so they are not treated as new, but their
recorded interaction is gone and `behavior.noRecentInteraction` starts firing
on their next protected state-changing request. In a run against a store capped
at five entries, a visitor's score on a protected `POST` went from 20 to 50
after a flood of cookie-less requests. That is a false positive against a real
user, which is the failure mode this package exists to avoid.

Any bounded cache can be flooded; the fix is not a bigger cap. In production,
pass a `BotStorage` backed by shared, persistent infrastructure such as Redis,
a database, or your platform's KV store, and let that layer handle capacity.

## Config

```ts
interface NoSkrapConfig {
  secret: string | string[];
  mode?: "observe" | "enforce";
  protectedRoutes?: string[];
  challengePath?: string;
  challengeTtlSeconds?: number;
  getClientIp?: (request: Request) => string | null | undefined;
  storage?: BotStorage;
  thresholds?: {
    observe: number;
    challenge: number;
    block: number;
  };
  rules?: RuleConfig[];
  now?: () => number;
}
```

Secrets must contain at least 32 characters. `createNoSkrapProxy` also accepts
an `onDecision(result, request)` callback for observation. Its result excludes
visitor IDs and cookie headers.

## Result

```ts
interface BotResult {
  decision: "allow" | "observe" | "challenge" | "block";
  score: number;
  reasons: BotReason[];
  visitorId: string;
  challengePassed: boolean;
  headers: Headers;
}
```

## Scoring

Default score bands:

| Score | Decision |
| ---: | --- |
| 0-29 | `allow` |
| 30-59 | `observe` |
| 60-84 | `challenge` |
| 85+ | `block` |

Built-in signals cover:

- missing browser headers on HTML navigation
- automation user-agent tokens
- user-agent and Client Hints platform mismatch
- weak fetch metadata on protected state-changing requests
- missing visitor-cookie continuity on protected routes
- protected state-changing requests without recent interaction
- route bursts per visitor and, when configured, IP address

Each contribution includes a stable `ruleId` and score. Rules can be disabled
or rescored:

```ts
createNoSkrapProxy({
  secret: process.env.NOSKRAP_SECRET!,
  rules: [
    { id: "browser.automationUa", score: 20 },
    { id: "headers.uaClientHintsMismatch", enabled: false },
  ],
});
```
