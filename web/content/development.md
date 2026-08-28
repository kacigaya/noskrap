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

That builds with TypeScript and runs the Bun test suite.

CI runs more than that, so run the rest before opening a pull request:

```bash
bun pm pack --dry-run      # what the published tarball would contain
cd web && bun run lint     # docs site lint
cd web && bun run build    # docs site static export
```

## Test app

The repo does not ship a demo app. `test-next-app/` is gitignored, so you can
scaffold a throwaway Next.js app there and link the package into it without
the scratch work showing up in `git status`:

```bash
bun create next-app test-next-app
cd test-next-app
bun add ../
bun run dev
```

Use it to check proxy behavior, route handlers, telemetry, and the client popup
in a real browser. Run `bun run build` in the repo root first — the package
entrypoints resolve to `dist/`, which is only produced by a build.

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
