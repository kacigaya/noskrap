# NoSkrap documentation

Static Next.js site for the NoSkrap landing page and documentation.

```bash
bun install
bun run dev
```

Run `bun run lint && bun run build` before deployment. GitHub Pages builds
with `NEXT_PUBLIC_BASE_PATH=/noskrap`.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_BASE_PATH` | empty | Path prefix for assets and routes. |
| `NEXT_PUBLIC_SITE_URL` | `https://kacigaya.github.io/noskrap` | Origin used for canonical, Open Graph, sitemap, and robots URLs. |

`NEXT_PUBLIC_SITE_URL` is intentionally independent of the base path: canonical
URLs must point at the published site even when a build runs without one.

## Adding a page

Add the Markdown file under `content/`, then list it in `NAV` in
`src/lib/docs-nav.ts`. The nav drives the static params, the sidebar, and the
sitemap, so a page missing from it will not be built.
