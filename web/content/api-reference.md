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
| `MemoryBotStorage` | Process-local storage for development and tests. |
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
  storage: new MemoryBotStorage(),
  protectedRoutes: ["/api/search"],
});

console.log(result.decision, result.score, result.reasons);
```

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
