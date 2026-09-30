# Development

Clone the repo and install dependencies for the package and the docs site:

```bash
git clone https://github.com/kacigaya/noskrap.git
cd noskrap
bun install
bun install --cwd web
bun install --cwd tests/next15
```

Run the checks:

```bash
NOSKRAP_TEST_REDIS_URL=redis://127.0.0.1:6379 bun run check
```

That is the same gate CI runs: TypeScript build, Bun test suite, a dry-run
pack to confirm the published tarball contents, then lint and static export of
the docs site. `bun run check:web` runs only the docs site part.

## Test app

The integration fixture is a test harness, not a supported demo app.
`test-next-app/` is gitignored, so you can
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

## Integration and audit gates

Use Bun 1.3.14 and a disposable Redis 7+ service (CI supplies Redis 7.4):

```bash
NOSKRAP_TEST_REDIS_URL=redis://127.0.0.1:6379 bun run check
bun audit --audit-level=high
(cd web && bun audit --audit-level=high)
(cd tests/next15 && bun audit --audit-level=high)
```

The full gate also type-checks tests and runs real Redis Lua plus production
Next.js 16 proxy and Next.js 15 Edge middleware fixtures on Node.js. It checks
cookie forwarding, single scoring,
interaction sharing across bundles, challenge POST status and recovery access.
Fixture files are copied into the ignored `test-next-app/` directory and cleaned
up afterward. Redis tests remove only their unique namespace; use a test service.

For the static docs export, use `python3 -m http.server 8080 --directory web/out`
from the repository root. `next start` is unsupported with `output: "export"`.

The Next.js 15 test environment pins PostCSS 8.5.23 to replace its vulnerable
transitive version. Keep the compatibility fixture and override verified when
updating either dependency.
