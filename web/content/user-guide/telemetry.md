# Telemetry

Telemetry records coarse visitor behavior. NoSkrap stores only the latest
verified interaction timestamp.

## Route handler

```ts
// app/api/noskrap/telemetry/route.ts
import { createNoSkrapTelemetryHandler } from "noskrap/next";
import { verifyTelemetryToken } from "noskrap/core";
import { noSkrapConfig } from "@/lib/noskrap";

export const POST = createNoSkrapTelemetryHandler({
  ...noSkrapConfig,
  verifyTelemetry: (request) => verifyTelemetryToken(request, noSkrapConfig),
});
```

`verifyTelemetry` is required. Without a token check, any client can send
`{ "interacted": true }` and remove `behavior.noRecentInteraction`. A header
such as `sec-fetch-site: same-origin` is not proof, because clients can set it.

## Telemetry token

`createTelemetryToken(request, config)` signs a token for the visitor in the
request cookie. `verifyTelemetryToken(request, config, options?)` accepts the
`x-noskrap-telemetry` header when all of these are true:

1. The token is signed with one of your secrets.
2. The token belongs to the visitor in the request cookie.
3. The token is at least `minAgeMs` old (default 0).
4. The token is less than `maxAgeMs` old (default 10 minutes).

The token proves that the visitor loaded a page you rendered. It does not
prove that a human used the page. A scraper that reads the token from the page
and waits can still send telemetry. Use a challenge provider in
`verifyChallenge` for stronger proof.

Issue the token in the layout, so every page has one:

```tsx
// app/layout.tsx
import { headers } from "next/headers";
import { createTelemetryToken } from "noskrap/core";
import { noSkrapConfig } from "@/lib/noskrap";
import { NoSkrapBeacon } from "./beacon";

export default async function Layout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const token = await createTelemetryToken(
    new Request("https://app.invalid/", { headers: requestHeaders }),
    noSkrapConfig,
  );
  return (
    <html lang="en">
      <body>
        {token ? <NoSkrapBeacon token={token} /> : null}
        {children}
      </body>
    </html>
  );
}
```

The proxy must match the page. It puts the new visitor cookie on the first
request, so first visits get a token too.

## Client beacon

```ts
"use client";

import { useEffect } from "react";

export function NoSkrapBeacon({ token }: { token: string }) {
  useEffect(() => {
    const send = (payload: { interacted: boolean }) => {
      void fetch("/api/noskrap/telemetry", {
        method: "POST",
        headers: { "x-noskrap-telemetry": token },
        body: JSON.stringify(payload),
      });
    };
    const interact = () => send({ interacted: true });

    window.addEventListener("pointerdown", interact, { once: true });
    window.addEventListener("keydown", interact, { once: true });

    return () => {
      window.removeEventListener("pointerdown", interact);
      window.removeEventListener("keydown", interact);
    };
  }, [token]);

  return null;
}
```

Recent verified interaction lowers risk for protected state-changing requests.

Use the shared configuration shown in the API reference. Add this exact route
to the proxy's `recoveryRoutes`, keep verification enabled, and apply abuse
limits in your application. You can replace `verifyTelemetryToken` with your
own check, for example an authenticated session.

`verifyTelemetry(request, payload, rawBody)` receives at most 1,024 bytes of
raw body for signature verification. The request stream has already been read;
use `rawBody` rather than calling `request.text()` again. Existing two-argument
verifiers remain compatible. Successful true telemetry atomically preserves
the newest timestamp for 10 minutes. False telemetry does not clear it.
Storage failure returns 503 so clients can retry deliberately.
