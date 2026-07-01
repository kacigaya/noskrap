# Telemetry

Telemetry records coarse visitor behavior. NoSkrap stores timestamps for page views and recent interactions.

## Route handler

```ts
// app/api/noskrap/telemetry/route.ts
import { createNoSkrapTelemetryHandler } from "noskrap/next";

export const POST = createNoSkrapTelemetryHandler({
  secret: process.env.NOSKRAP_SECRET!,
});
```

## Client beacon

```ts
"use client";

import { useEffect } from "react";

export function NoSkrapBeacon() {
  useEffect(() => {
    const send = (payload: { pageView?: boolean; interacted?: boolean }) => {
      void fetch("/api/noskrap/telemetry", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    };
    const interact = () => send({ interacted: true });

    send({ pageView: true });
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

Recent interaction lowers risk for protected state-changing requests.
