# Installation

Install NoSkrap with Bun:

```bash
bun add noskrap
```

NoSkrap ships ESM exports:

| Export | Use |
| --- | --- |
| `noskrap/next` | Next.js proxy and route handler helpers. |
| `noskrap/core` | Framework-independent scoring and storage types. |
| `noskrap/client` | Browser popup helper. |

## Requirements

- Next.js 15 or newer for `noskrap/next`.
- A secret value in `NOSKRAP_SECRET`.
- A production storage adapter when in-memory process-local storage is not enough.

## Environment

```bash
NOSKRAP_SECRET="replace-with-a-long-random-secret"
```

Use secret rotation by passing an array. The first secret signs new cookies; all secrets verify existing cookies.

```ts
secret: [process.env.NOSKRAP_SECRET!, process.env.NOSKRAP_OLD_SECRET!]
```
