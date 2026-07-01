import type { BotDecision } from "./core.js";

export interface BotDetectedPopupOptions {
  message?: string;
  detectedDecisions?: BotDecision[];
  show?: (message: string) => void;
}

export function showBotDetectedPopup(
  result: BotDecision | { decision: BotDecision },
  options: BotDetectedPopupOptions = {},
): boolean {
  const decision = typeof result === "string" ? result : result.decision;
  const detectedDecisions = options.detectedDecisions ?? ["challenge", "block"];

  if (!detectedDecisions.includes(decision)) return false;

  (options.show ?? globalThis.alert)(options.message ?? "Bot detected.");
  return true;
}
