# Quickstart

This guide starts with observation. You can ship the proxy, collect decisions, and turn on enforcement after you trust the scores.

## Add the proxy

```ts
// proxy.ts
import { createNoSkrapProxy } from "noskrap/next";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};

export const proxy = createNoSkrapProxy({
  secret: process.env.NOSKRAP_SECRET!,
  protectedRoutes: ["/api/search", "/login", "/checkout"],
  onDecision: (result) => console.info("noskrap", result),
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

The proxy runs in observe mode unless `mode: "enforce"` is set. In observe mode it sets visitor continuity cookies and returns `NextResponse.next()`.

## Inspect a decision in a route handler

Route handlers are useful when one endpoint needs to decide locally.

```ts
import { getNoSkrapDecision } from "noskrap/next";

export async function POST(request: Request) {
  const result = await getNoSkrapDecision(request, {
    secret: process.env.NOSKRAP_SECRET!,
    protectedRoutes: ["/api/search"],
  });

  return Response.json({
    decision: result.decision,
    score: result.score,
    reasons: result.reasons,
  }, { headers: result.headers });
}
```

## Add telemetry

Telemetry gives NoSkrap one coarse human signal: recent interaction.

```ts
// app/api/noskrap/telemetry/route.ts
import { createNoSkrapTelemetryHandler } from "noskrap/next";

export const POST = createNoSkrapTelemetryHandler({
  secret: process.env.NOSKRAP_SECRET!,
  verifyTelemetry: (request) => verifyYourTelemetryToken(request),
});
```

```ts
fetch("/api/noskrap/telemetry", {
  method: "POST",
  body: JSON.stringify({ interacted: true }),
});
```

## Enforce later

When scores look sane in logs, switch the proxy to enforce mode.

```ts
export const proxy = createNoSkrapProxy({
  secret: process.env.NOSKRAP_SECRET!,
  mode: "enforce",
  protectedRoutes: ["/api/search", "/login", "/checkout"],
  challengePath: "/bot-check",
  recoveryRoutes: ["/api/noskrap/telemetry", "/api/noskrap/challenge-pass"],
});
```

This inspection example exposes scores for development and does not enforce
a decision locally. See Route Handlers for rejection and outage handling.
