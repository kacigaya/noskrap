<p align="center">
  <img src="./assets/logo.svg" alt="NoSkrap logo" width="160" />
</p>

<h1 align="center">NoSkrap</h1>

<p align="center">
  TypeScript bot-risk scoring for Next.js apps.<br>
  Explainable decisions: <code>allow</code>, <code>observe</code>, <code>challenge</code>, or <code>block</code>.
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

NoSkrap starts in observe mode, so it scores traffic without blocking it.

## Documentation

See the [full documentation](https://kacigaya.github.io/noskrap/docs/) for
enforcement, challenge passes, telemetry, storage, configuration, security,
and the API reference.

NoSkrap is risk scoring, not guaranteed bot blocking.

## License

[MIT](LICENSE)
