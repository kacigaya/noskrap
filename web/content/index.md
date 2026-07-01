# NoSkrap

TypeScript bot-risk framework for Next.js apps. NoSkrap scores each request with coherent signals and returns one decision: `allow`, `observe`, `challenge`, or `block`.

## Install

```bash
bun add noskrap
```

## First proxy

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

Default mode is `observe`, so NoSkrap scores requests and sets a signed visitor cookie without blocking traffic.

## Decisions

| Score | Decision |
| ---: | --- |
| 0-29 | `allow` |
| 30-59 | `observe` |
| 60-84 | `challenge` |
| 85+ | `block` |

## Explore

- [Installation](/docs/getting-started/installation)
- [Quickstart](/docs/getting-started/quickstart)
- [Next Proxy](/docs/user-guide/next-proxy)
- [Route Handlers](/docs/user-guide/route-handlers)
- [Telemetry](/docs/user-guide/telemetry)
- [Challenge Pass](/docs/user-guide/challenge-pass)
- [Client Popup](/docs/user-guide/client-popup)
- [API Reference](/docs/api-reference)
