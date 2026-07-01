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
});
```

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
  });
}
```

## Add telemetry

Telemetry gives NoSkrap one coarse human signal: recent interaction.

```ts
// app/api/noskrap/telemetry/route.ts
import { createNoSkrapTelemetryHandler } from "noskrap/next";

export const POST = createNoSkrapTelemetryHandler({
  secret: process.env.NOSKRAP_SECRET!,
});
```

```ts
fetch("/api/noskrap/telemetry", {
  method: "POST",
  body: JSON.stringify({ pageView: true, interacted: true }),
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
});
```
