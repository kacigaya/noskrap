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

That is the same gate CI runs: TypeScript build, Bun test suite, packed
entrypoint checks under Node.js, then lint and static export of
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

The full gate also type-checks tests and runs the real node-redis, ioredis and Upstash SDKs against Redis, plus production
Next.js 16 proxy and Next.js 15 Edge middleware fixtures on Node.js. It checks
cookie forwarding, single scoring through rewrites and delayed context checks,
interaction sharing across bundles, challenge POST status and recovery access.
The Upstash SDK uses a local HTTP-to-Redis bridge; hosted Upstash deployment and
credentials are outside this local gate.
Fixture files are copied into the ignored `test-next-app/` directory and cleaned
up afterward. Redis tests remove only their unique namespace; use a test service.

For the static docs export, use `python3 -m http.server 8080 --directory web/out`
from the repository root. `next start` is unsupported with `output: "export"`.

The Next.js 15 test environment pins PostCSS 8.5.23 to replace its vulnerable
transitive version. Keep the compatibility fixture and override verified when
updating either dependency.

## npm releases

The public package name is `noskrap`. `.github/workflows/publish.yml` publishes
stable GitHub releases through npm trusted publishing, without a stored npm
token. Publication requires a `vX.Y.Z` tag matching `package.json` and pointing
to a commit already on `main`. Prereleases are skipped.

The workflow installs frozen dependency trees, audits all three trees, and runs
the full gate against Redis 7.4. It tests the packed tarball's four entrypoints
under Node.js without development dependencies. A separate job publishes that
same verified tarball; only that job receives permission to request an OIDC
token. npm CLI 11.21.0 is pinned because trusted publishing requires at least
11.5.1. npm generates provenance for public packages published this way.

### One-time account setup

Trusted publishing must be configured in an existing package's npm settings.
If `npm view noskrap --registry=https://registry.npmjs.org` returns 404, an npm
maintainer must create the package first. Authenticate locally with `npm login`;
never paste account credentials into issues, pull requests or configuration.
Build, validate and pack the approved release checkout, then publish its
`noskrap-X.Y.Z.tgz` with:

```bash
npm publish noskrap-X.Y.Z.tgz --access public --registry=https://registry.npmjs.org
```

For the already approved v0.4.0 release, use a separate checkout of the v0.4.0
tag, its frozen dependencies and its full validation gate. Do not publish the
unmerged branch under the existing 0.4.0 version. npm versions are immutable.

After the first publication, configure the package's **Trusted Publisher**:

- Provider: GitHub Actions.
- Organization/user: `kacigaya`.
- Repository: `noskrap`.
- Workflow filename: `publish.yml`.
- Allow **direct publishing** with `npm publish`; the default staging-only
  permission does not permit this workflow's publish command.

This workflow requires GitHub-hosted runners. After setup, future stable
releases publish automatically. Increment the manifest version in its own
release commit, merge it to `main`, tag that commit, and publish the matching
GitHub release. Check the publication job and verify `npm view noskrap version`
afterward. Failed jobs do not roll back the GitHub release. If validation passes
but publishing fails, resolve npm account/trust configuration before rerunning
the failed job; verify whether the version already exists first.

See npm's [trusted publishing guide](https://docs.npmjs.com/trusted-publishers/)
for account setup, direct publishing permission and provenance requirements.
