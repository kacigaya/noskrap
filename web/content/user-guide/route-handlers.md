# Route Handlers

Use `getNoSkrapDecision` when an endpoint needs to inspect or enforce the decision.

```ts
import { getNoSkrapDecision } from "noskrap/next";
import { noSkrapConfig } from "@/lib/noskrap";

export async function POST(request: Request) {
  const result = await getNoSkrapDecision(request, noSkrapConfig);
  if (!result.scoringAvailable) {
    return Response.json({ error: "scoring unavailable" }, {
      status: 503, headers: result.headers,
    });
  }
  if (result.decision === "block" || result.decision === "challenge") {
    return Response.json({ error: "verification required" }, {
      status: 403, headers: result.headers,
    });
  }
  return Response.json({ ok: true }, { headers: result.headers });
}
```

Define `noSkrapConfig` in one shared module with your secret, protected routes,
and production storage. Return `result.headers` on every response so visitor
continuity survives both success and rejection. The example closes on storage
failure; choose that policy explicitly for endpoints enforcing locally.

When the proxy already scored the request, this helper verifies and reuses its
signed context instead of incrementing counters again. The context binds the
URL, method and forwarded visitor cookie, expires after 30 seconds, and requires
the same secrets in both layers. A handler reached directly scores normally.
Use the same policy configuration in both layers: the proxy owns the decision
when its context is valid. Use `scoreRequest` explicitly if you need a different
policy, accepting another counter increment.

Keep `x-noskrap-context` and Next.js internal request override headers private.
Do not echo them to clients or log them. Rewrites that change the URL, or
handlers delayed beyond 30 seconds, cannot reuse the original context and will
score again.

Each reason contains a stable `ruleId` and score contribution. Log these on the
server for tuning; publish them only if your application's API needs them.
