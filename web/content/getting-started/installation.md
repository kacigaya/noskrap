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
- A secret of at least 32 characters in `NOSKRAP_SECRET`.
- A shared `BotStorage` adapter for any deployment that runs more than one instance.

## Environment

```bash
NOSKRAP_SECRET="replace-with-at-least-32-random-characters"
```

Use secret rotation by passing an array. The first secret signs new cookies; all secrets verify existing cookies.

```ts
secret: [process.env.NOSKRAP_SECRET!, process.env.NOSKRAP_OLD_SECRET!]
```

## Production notes

- Visitor cookies are HMAC signed and use `HttpOnly`, `Secure`,
  `SameSite=Lax`, and `Path=/`.
- Never log raw secrets, complete cookies, or challenge tokens.
- Omitting `storage` falls back to bounded, in-memory, process-local storage and
  logs a warning. Rate limiting and interaction continuity degrade silently
  across instances, so provide a shared `BotStorage` in production.
- Configure client IP resolution only from infrastructure-provided values you
  trust.
- NoSkrap is risk scoring, not guaranteed bot blocking.
