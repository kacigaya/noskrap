# Quickstart

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

The proxy runs in observe mode unless `mode: "enforce"` is set.

## Inspect a decision in a route handler

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

```ts
export const proxy = createNoSkrapProxy({
  secret: process.env.NOSKRAP_SECRET!,
  mode: "enforce",
  protectedRoutes: ["/api/search", "/login", "/checkout"],
  challengePath: "/bot-check",
});
```
