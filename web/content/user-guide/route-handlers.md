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
URL, method and forwarded visitor cookie, expires after 30 seconds by default,
and requires the same secrets in both layers. A handler reached directly scores normally.
Use the same policy configuration in both layers: the proxy owns the decision
when its context is valid. Use `scoreRequest` explicitly if you need a different
policy, accepting another counter increment.

Keep `x-noskrap-context` and Next.js internal request override headers private.
Do not echo them to clients or log them. Read the decision at handler entry,
before slow work. For measured proxy-to-handler delays, set `contextTtlMs` in
both layers; it accepts 1–300,000 ms. A longer lifetime increases the replay
window if an internal context leaks. Expired context still triggers fresh
scoring, including another counter increment.

Resolve rewrites inside NoSkrap so scoring and the signed context use the
same destination URL:

```ts
export const proxy = createNoSkrapProxy({
  ...noSkrapConfig,
  rewrite: request => new URL(request.url).pathname === "/search"
    ? new URL(`/api/search${new URL(request.url).search}`, request.url)
    : null,
});
```

Context remains bound to the exact destination URL. If Next.js runs the proxy
again after rewriting, it reuses only a verified rewrite context for that
destination; counters and observation callbacks run once.
The synchronous resolver must return a same-origin URL without a fragment or
`null`. Configure `protectedRoutes` for destination paths and include aliases
in the Next.js matcher. The original method, body and query selected by the
resolver reach the rewritten handler. Recovery routes bypass the resolver.
External rewrites or rewrites added after scoring change the bound URL and
trigger fresh scoring; use the integrated resolver to avoid duplicate counts.

Each reason contains a stable `ruleId` and score contribution. Log these on the
server for tuning; publish them only if your application's API needs them.
