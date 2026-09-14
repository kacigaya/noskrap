# Development

Clone the repo and install dependencies for the package and the docs site:

```bash
git clone https://github.com/kacigaya/noskrap.git
cd noskrap
bun install
bun install --cwd web
```

Run the checks:

```bash
bun run check
```

That is the same gate CI runs: TypeScript build, Bun test suite, a dry-run
pack to confirm the published tarball contents, then lint and static export of
the docs site. `bun run check:web` runs only the docs site part.

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
