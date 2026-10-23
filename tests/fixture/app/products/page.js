import { getNoSkrapPageDecision } from "noskrap/next";
import { config } from "../../shared.js";

export default async function Products() {
  const decision = await getNoSkrapPageDecision("/products", config);
  return <pre id="decision">{JSON.stringify({ score: decision.score, reasons: decision.reasons })}</pre>;
}
