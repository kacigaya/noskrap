# Challenge Pass

A challenge pass lets your app mark a visitor as verified after a challenge page succeeds.

NoSkrap does not provide a CAPTCHA vendor integration. Verify the visitor with your own page or provider, then issue the pass.

## Pass route

```ts
// app/api/noskrap/challenge-pass/route.ts
import { createNoSkrapChallengePassHandler } from "noskrap/next";

export const POST = createNoSkrapChallengePassHandler({
  secret: process.env.NOSKRAP_SECRET!,
  verifyChallenge: (request) => verifyYourCaptcha(request),
});
```

`verifyChallenge` is required and runs before NoSkrap issues a pass. The
request must also contain the signed visitor cookie created by the proxy.

## Proxy with challenge path

```ts
import { createNoSkrapProxy } from "noskrap/next";

export const proxy = createNoSkrapProxy({
  secret: process.env.NOSKRAP_SECRET!,
  mode: "enforce",
  protectedRoutes: ["/api/search", "/checkout"],
  challengePath: "/bot-check",
});
```

## TTL

The pass defaults to 10 minutes.

```ts
createNoSkrapChallengePassHandler({
  secret: process.env.NOSKRAP_SECRET!,
  challengeTtlSeconds: 5 * 60,
  verifyChallenge: (request) => verifyYourCaptcha(request),
});
```

The pass only downgrades `challenge` to `allow`. `block` decisions still block.
