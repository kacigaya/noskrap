# Telemetry

Telemetry records coarse visitor behavior. NoSkrap stores only the latest
verified interaction timestamp.

## Route handler

```ts
// app/api/noskrap/telemetry/route.ts
import { createNoSkrapTelemetryHandler } from "noskrap/next";

export const POST = createNoSkrapTelemetryHandler({
  secret: process.env.NOSKRAP_SECRET!,
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
