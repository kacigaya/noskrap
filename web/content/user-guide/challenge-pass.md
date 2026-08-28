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

## Returning the visitor

When the proxy redirects to `challengePath`, it appends a `next` query
parameter holding the path and query string the visitor originally asked for.
Send them back there once the challenge succeeds.

```tsx
// app/bot-check/page.tsx
export default async function BotCheck({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // ...
}
```

NoSkrap always writes `next` as a same-origin absolute path, so a request for a
protocol-relative path such as `//example.com/x` cannot turn the parameter into
an offsite redirect. The value still comes from the client, so treat it as
untrusted input: check it against the routes you are willing to return to
before redirecting.

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
