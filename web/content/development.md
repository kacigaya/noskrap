# Development

Clone the repo and install dependencies:

```bash
git clone https://github.com/kacigaya/noskrap.git
cd noskrap
bun install
```

Run the package checks:

```bash
bun run check
```

This runs TypeScript build and the Bun test suite.

## Test app

The repo includes `test-next-app/` for local smoke testing with Next.js.

```bash
cd test-next-app
bun install
bun run dev
```

Use it to verify proxy behavior, route handlers, telemetry, and client popup flows in a browser.

## Docs app

The docs site lives in `web/`.

```bash
cd web
bun install
bun run dev
```

Build before shipping docs changes:

```bash
bun run build
```
