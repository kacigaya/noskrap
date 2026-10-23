# Challenge Pass

A challenge pass lets your app mark a visitor as verified after a challenge page succeeds.

Use the built-in Cloudflare Turnstile adapter, or supply your own verifier.
A challenge requires `mode: "enforce"`, a `challengePath`, and a score at the
challenge threshold. Adding a provider does not raise low browser scores.

## Cloudflare Turnstile

1. Create a Turnstile widget for your app's hostname in Cloudflare.
2. Keep the secret key on the server. Use the site key in your challenge page.
3. Configure the pass route with the expected hostname and action.

```ts
// app/api/noskrap/challenge-pass/route.ts
import {
  createNoSkrapChallengePassHandler,
  createTurnstileVerifier,
} from "noskrap/next";
import { noSkrapConfig } from "@/lib/noskrap";

export const POST = createNoSkrapChallengePassHandler({
  ...noSkrapConfig,
  verifyChallenge: createTurnstileVerifier({
    secretKey: process.env.TURNSTILE_SECRET_KEY!,
    expectedHostname: "example.com",
    expectedAction: "noskrap",
  }),
});
```

Embed the [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)
on `/bot-check`. Set its action to `noskrap`. Send its success token to the
pass route as JSON:

```ts
async function onTurnstileSuccess(token: string) {
  const response = await fetch("/api/noskrap/challenge-pass", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error("Verification failed. Try the challenge again.");
  // Return to an allowed same-origin path after the pass cookie is set.
}
```

The adapter checks `success`, the exact `expectedHostname`, and the optional
`expectedAction` from Cloudflare's response. It rejects missing or oversized
tokens before contacting Cloudflare. It reads at most 4,096 request bytes.
It sends only the token and secret key to Cloudflare. It does not forward IP
headers. No extra package dependency is required.

[Cloudflare validates token expiry and single use](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
Invalid, expired, or reused tokens return 401. Network errors, provider errors,
and the handler's verification timeout return 503. Neither response issues a
pass. Reset the widget to get a fresh token before retrying. The handler's
`verificationTimeoutMs` defaults to 5,000 ms and cancels the provider request.
Apply abuse limits to this public route in your app.

## Custom verifier

```ts
import { createNoSkrapChallengePassHandler } from "noskrap/next";
import { noSkrapConfig } from "@/lib/noskrap";

export const POST = createNoSkrapChallengePassHandler({
  ...noSkrapConfig,
  verifyChallenge: (request, signal) => verifyYourCaptcha(request, signal),
});
```

`verifyChallenge` is required and runs before NoSkrap issues a pass. The
request must also contain the signed visitor cookie created by the proxy.

## Proxy with challenge path

```ts
import { createNoSkrapProxy } from "noskrap/next";
import { noSkrapConfig } from "@/lib/noskrap";

export const proxy = createNoSkrapProxy({
  ...noSkrapConfig,
  mode: "enforce",
  protectedRoutes: ["/api/search", "/checkout"],
  challengePath: "/bot-check",
  recoveryRoutes: ["/api/noskrap/telemetry", "/api/noskrap/challenge-pass"],
});
```

## Returning the visitor

When the proxy redirects to `challengePath`, it appends a `next` query
parameter holding the path and query string the visitor originally asked for.
Send them back there once the challenge succeeds.

```tsx
// app/bot-check/page.tsx
export default async function BotCheck({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // ...
}
```

NoSkrap always writes `next` as a same-origin absolute path, so a request for a
protocol-relative path such as `//example.com/x` cannot turn the parameter into
an offsite redirect. The value still comes from the client, so treat it as
untrusted input: check it against the routes you are willing to return to
before redirecting.

## TTL

The pass defaults to 10 minutes.

```ts
createNoSkrapChallengePassHandler({
  ...noSkrapConfig,
  challengeTtlSeconds: 5 * 60,
  verifyChallenge: (request) => verifyYourCaptcha(request),
});
```

The pass only downgrades `challenge` to `allow`. `block` decisions still block.

API clients receive 403 JSON with `challengeUrl`; show that page and explicitly
retry the original operation after a pass. Form POSTs use 303 so their bodies
are not replayed to the challenge page. Original POST bodies are not stored.
