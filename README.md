<p align="center">
  <img src="assets/logo.svg" alt="NoSkrap logo" width="140">
</p>

<h1 align="center">NoSkrap</h1>

<p align="center">
  <strong>Score bot risk in your Next.js app, and see why each score happened.</strong><br>
  <em>Request signals, signed visitor continuity, route velocity, interaction telemetry, and challenge passes.</em>
</p>

<p align="center">
  <a href="https://www.typescriptlang.org"><img alt="TypeScript 5.9" src="https://shieldcn.dev/badge/TypeScript-5.9-3178c6.svg?variant=secondary&amp;logo=typescript"></a>
  <a href="https://nextjs.org"><img alt="Next.js 15+" src="https://shieldcn.dev/badge/Next.js-15+-171717.svg?variant=secondary&amp;logo=nextdotjs"></a>
  <a href="https://bun.sh"><img alt="Bun 1.3" src="https://shieldcn.dev/badge/Bun-1.3-fbf0df.svg?variant=secondary&amp;logo=bun&amp;logoColor=171717"></a>
  <a href="https://github.com/kacigaya/noskrap/blob/main/LICENSE"><img alt="MIT License" src="https://shieldcn.dev/github/license/kacigaya/noskrap.svg?variant=secondary"></a>
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
