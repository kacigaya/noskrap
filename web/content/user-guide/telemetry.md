# Telemetry

Telemetry records coarse visitor behavior. NoSkrap stores only the latest
verified interaction timestamp.

## Route handler

```ts
// app/api/noskrap/telemetry/route.ts
import { createNoSkrapTelemetryHandler } from "noskrap/next";
import { noSkrapConfig } from "@/lib/noskrap";

export const POST = createNoSkrapTelemetryHandler({
  ...noSkrapConfig,
  verifyTelemetry: (request) => verifyYourTelemetryToken(request),
});
```

`verifyTelemetry` is required. Use an authenticated session or a short-lived
token issued by your app; the client-provided interaction flag is not proof of
humanity by itself.

## Client beacon

```ts
"use client";

import { useEffect } from "react";

export function NoSkrapBeacon() {
  useEffect(() => {
    const send = (payload: { interacted: boolean }) => {
      void fetch("/api/noskrap/telemetry", {
        method: "POST",
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
  }, []);

  return null;
}
```

Recent verified interaction lowers risk for protected state-changing requests.

Use the shared configuration shown in the API reference. Add this exact route
to the proxy's `recoveryRoutes`, keep verification enabled, and apply abuse
limits in your application. Include the session or app-issued token required
by your verifier in the beacon; the minimal fetch above omits token issuance.

`verifyTelemetry(request, payload, rawBody)` receives at most 1,024 bytes of
raw body for signature verification. The request stream has already been read;
use `rawBody` rather than calling `request.text()` again. Existing two-argument
verifiers remain compatible. Successful true telemetry atomically preserves
the newest timestamp for 10 minutes. False telemetry does not clear it.
Storage failure returns 503 so clients can retry deliberately.
