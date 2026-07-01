# NoSkrap

NoSkrap helps Next.js apps handle suspicious traffic without starting with a hard block. It scores each request, explains the signals behind the score, and lets you choose when to observe, challenge, or block.

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

Default mode is `observe`, so the first deploy is low risk. NoSkrap scores requests and sets a signed visitor cookie, but every request still continues.

## Decisions

Scores map to four decisions:

| Score | Decision |
| ---: | --- |
| 0-29 | `allow` |
| 30-59 | `observe` |
| 60-84 | `challenge` |
| 85+ | `block` |

Use observe mode to learn what normal traffic looks like. Turn on enforce mode when you know which routes should challenge or block high-risk requests.

## Explore

- [Installation](/docs/getting-started/installation)
- [Quickstart](/docs/getting-started/quickstart)
- [Next Proxy](/docs/user-guide/next-proxy)
- [Route Handlers](/docs/user-guide/route-handlers)
- [Telemetry](/docs/user-guide/telemetry)
- [Challenge Pass](/docs/user-guide/challenge-pass)
- [Client Popup](/docs/user-guide/client-popup)
- [API Reference](/docs/api-reference)
