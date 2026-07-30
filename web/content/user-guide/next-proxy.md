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
- `challenge` redirects to `challengePath` when configured.
- `allow` and `observe` continue.

```ts
createNoSkrapProxy({
  secret: process.env.NOSKRAP_SECRET!,
  mode: "enforce",
  protectedRoutes: ["/api/search"],
  challengePath: "/bot-check",
});
```

## Protected routes

A protected route matches the exact path or any child path.

```ts
protectedRoutes: ["/api/search"]
```

This protects `/api/search` and `/api/search/suggestions`.

## Client IP

IP rate limiting is disabled unless you supply a trusted resolver:

```ts
getClientIp: (request) => request.headers.get("cf-connecting-ip")
```

Only read a header your deployment platform overwrites; never trust arbitrary
forwarded headers from the public internet.
