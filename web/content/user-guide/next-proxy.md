# Next Proxy

`createNoSkrapProxy` wraps Next.js proxy middleware and applies the core scorer to matching requests.

```ts
import { createNoSkrapProxy } from "noskrap/next";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export const proxy = createNoSkrapProxy({
  secret: process.env.NOSKRAP_SECRET!,
  protectedRoutes: ["/api/search", "/login", "/checkout"],
});
```

The example uses Next.js 16's `proxy.ts`. For Next.js 15, create
`middleware.ts` instead and export `middleware`:

```ts
import { createNoSkrapProxy } from "noskrap/next";

export const middleware = createNoSkrapProxy({
  secret: process.env.NOSKRAP_SECRET!,
  protectedRoutes: ["/api/search", "/login", "/checkout"],
});
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
```

Use a shared production storage implementation in every entrypoint. The memory
fallback is for tests and development; Next.js proxy and route bundles can
have separate stores even on a single server. See the API reference for Redis
configuration and Edge-compatible adapters.

## Observe mode

Observe mode is the default. It scores traffic, returns `NextResponse.next()`, and sets the signed visitor cookie.

```ts
createNoSkrapProxy({
  secret: process.env.NOSKRAP_SECRET!,
  protectedRoutes: ["/api/search"],
  onDecision: (result) => console.info("noskrap", result),
});
```

The callback is the observation path; NoSkrap does not expose risk details to
the client.

## Enforce mode

In enforce mode:

- `block` returns `403`.
- `challenge` redirects browser navigation to `challengePath` when configured:
  307 for GET/HEAD, 303 for other methods. API/fetch requests receive 403 JSON
  with `challengeUrl`. Without a challenge path, the
  request continues like `observe`; the decision still reaches `onDecision`.
- `allow` and `observe` continue.

Every response, including the `403` and the redirect, carries the signed
visitor cookie so continuity survives enforcement.

```ts
createNoSkrapProxy({
  secret: process.env.NOSKRAP_SECRET!,
  mode: "enforce",
  protectedRoutes: ["/api/search"],
  challengePath: "/bot-check",
  recoveryRoutes: ["/api/noskrap/telemetry", "/api/noskrap/challenge-pass"],
});
```

## Protected routes

A protected route matches the exact path or any child path.

```ts
protectedRoutes: ["/api/search"]
```

This protects `/api/search` and `/api/search/suggestions`. Trailing slashes are
ignored; `/` protects every path, while `/api/searching` stays separate.
Children share the longest matching protected prefix for rate counters.

## Client IP

IP rate limiting is disabled unless you supply a trusted resolver:

```ts
getClientIp: (request) => request.headers.get("cf-connecting-ip")
```

Only read a header your deployment platform overwrites; never trust arbitrary
forwarded headers from the public internet.

## Recovery and outages

`recoveryRoutes` bypasses scoring and enforcement for exact paths only. Include
telemetry and challenge-pass endpoints so a challenged visitor can recover.
Their handlers must still verify proof and apply application-level abuse limits;
children of a recovery path remain protected. The challenge page avoids redirect
loops but still blocks high-risk requests unless explicitly listed for recovery.

Storage errors/timeouts default to passing requests in observe mode and 503 in
enforce mode. Configure `storageFailureMode` and `storageTimeoutMs` explicitly
when your service needs another policy; monitor `scoringAvailable` in
`onDecision`. A slow observation callback is awaited, so keep it bounded.
