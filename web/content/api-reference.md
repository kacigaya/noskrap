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
