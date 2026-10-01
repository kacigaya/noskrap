import { getNoSkrapDecision } from "noskrap/next";
import { config } from "../../../shared.js";
async function handler(request) {
  // Advance only the verifier clock to exercise a 31-second delivery delay.
  const delayed = new URL(request.url).searchParams.has("delayed");
  const result = await getNoSkrapDecision(request, delayed
    ? { ...config, now: () => Date.now() + 31_000 } : config);
  return Response.json({ visitorId: result.visitorId, score: result.score, reasons: result.reasons, challengePassed: result.challengePassed }, { headers: result.headers });
}
export { handler as GET, handler as POST };
