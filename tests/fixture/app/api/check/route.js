import { getNoSkrapDecision } from "noskrap/next";
import { config } from "../../../shared.js";
async function handler(request) {
  const result = await getNoSkrapDecision(request, config);
  return Response.json({ visitorId: result.visitorId, score: result.score, reasons: result.reasons, challengePassed: result.challengePassed }, { headers: result.headers });
}
export { handler as GET, handler as POST };
