# Project guidance

- Package manager/runtime: Bun 1.3.14 and Node.js 22.23.1; CI pins both. TypeScript builds ESM package exports into `dist/`.
- Install the package, docs and compatibility test trees: `bun install --frozen-lockfile` and `bun install --cwd web --frozen-lockfile`, and `bun install --cwd tests/next15 --frozen-lockfile`.
- Full gate: `NOSKRAP_TEST_REDIS_URL=redis://127.0.0.1:6379 bun run check`. This includes package build, test type-checking, unit tests, real Redis SDKs and production Next.js 15/16 integration, package contents, docs lint and static export.
- Integration needs a disposable Redis 7+ service and Node.js for the fixture's Next.js production runtime. CI provides Redis 7.4 on port 6379. Tests delete only their own randomly prefixed keys, never flush the database.
- Focused checks: `bun test src tests/publish.test.ts`, `bun run typecheck:tests`, `bun run test:redis-sdk`, `bun run test:integration`, `bun run test:next15`, `bun run test:package`, `bun run check:web`.
- Dependency gates: `bun audit --audit-level=high` in the root, `web/`, and `tests/next15/`.
- Docs development: `bun run --cwd web dev` (Next.js default port 3000); no production application service runs in this repository.
- Docs are a Next.js 16 static export in `web/out/`. Preview with `python3 -m http.server 8080 --directory web/out` after building. `next start` does not serve this export.
- GitHub Pages workflow builds with `NEXT_PUBLIC_BASE_PATH=/noskrap`, audits and lints before deployment. Production origin defaults to `https://kacigaya.github.io/noskrap`; override with `NEXT_PUBLIC_SITE_URL`.
- Package entrypoints: `noskrap/core`, `noskrap/next`, `noskrap/redis`, `noskrap/client`. Build before consuming them from the integration fixture.
- Do not add Redis production dependencies; use explicit adapters for the consumer's client.
- Keep proxy/handler policy and shared storage consistent. Never expose signed context or internal Next.js request override headers.

- Stable GitHub releases trigger `.github/workflows/publish.yml`: validate exact matching version/tag on main, run full gates, publish the tested tarball with npm OIDC. Requires initial npm package creation and trusted publisher for `kacigaya/noskrap`, workflow `publish.yml`, with direct publishing allowed. npm CLI 11.21.0 is pinned for this job.
