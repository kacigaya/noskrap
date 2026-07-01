# Route Handlers

Use `getNoSkrapDecision` when a route needs to inspect the decision directly.

```ts
import { getNoSkrapDecision } from "noskrap/next";

export async function POST(request: Request) {
  const result = await getNoSkrapDecision(request, {
    secret: process.env.NOSKRAP_SECRET!,
    protectedRoutes: ["/api/search"],
  });

  if (result.decision === "block") {
    return Response.json({ error: "blocked" }, { status: 403 });
  }

  return Response.json({
    decision: result.decision,
    score: result.score,
    reasons: result.reasons,
    challengePassed: result.challengePassed,
  });
}
```

## Reasons

Each reason includes a stable `ruleId` and a score contribution.

```json
{
  "decision": "challenge",
  "score": 60,
  "reasons": [
    { "ruleId": "browser.automationUa", "score": 30 },
    { "ruleId": "behavior.noRecentInteraction", "score": 30 }
  ]
}
```

Use rule ids for logs, dashboards, and tuning.
