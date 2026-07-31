<p align="center">
  <img src="assets/logo.svg" alt="NoSkrap logo" width="200">
</p>

<h1 align="center">NoSkrap</h1>

<p align="center">
  <strong>TypeScript bot-risk scoring for Next.js, with explainable request signals,
  signed visitor continuity, route velocity, interaction telemetry, and challenge passes.</strong>
</p>

## Install

```bash
bun add noskrap
```

## Quickstart

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

## Documentation

- [Quickstart](https://kacigaya.github.io/noskrap/docs/getting-started/quickstart/)
- [Next Proxy](https://kacigaya.github.io/noskrap/docs/user-guide/next-proxy/)
- [Route Handlers](https://kacigaya.github.io/noskrap/docs/user-guide/route-handlers/)
- [Telemetry](https://kacigaya.github.io/noskrap/docs/user-guide/telemetry/)
- [Challenge Pass](https://kacigaya.github.io/noskrap/docs/user-guide/challenge-pass/)
- [API Reference](https://kacigaya.github.io/noskrap/docs/api-reference/)
- [Development](https://kacigaya.github.io/noskrap/docs/development/)
