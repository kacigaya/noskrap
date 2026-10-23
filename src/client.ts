import type { BotDecision } from "./core.js";

export interface NoSkrapBeaconOptions {
  token: string;
  endpoint?: string;
}

export function startNoSkrapBeacon(options: NoSkrapBeaconOptions): () => void {
  const { token, endpoint = "/api/noskrap/telemetry" } = options;
  if (typeof token !== "string" || !token.trim()) {
    throw new TypeError("token must be a non-empty string");
  }
  if (typeof endpoint !== "string" || !endpoint.startsWith("/") ||
    endpoint.startsWith("//") || /[\\#\u0000-\u0020\u007f]/.test(endpoint)) {
    throw new TypeError("endpoint must be a same-origin absolute URL path");
  }
  if (typeof window === "undefined") return () => {};

  const target = window;
  let lastSent = -Infinity;
  let stopped = false;
  const interact = (event: Event) => {
    if (stopped || !event.isTrusted || Date.now() - lastSent < 5 * 60 * 1000) return;
    lastSent = Date.now();
    // Keep telemetry best-effort. Never interrupt the visitor's action on transport failure.
    void fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-noskrap-telemetry": token },
      body: JSON.stringify({ interacted: true }),
    }).catch(() => {});
  };
  target.addEventListener("pointerdown", interact);
  target.addEventListener("keydown", interact);

  return () => {
    stopped = true;
    target.removeEventListener("pointerdown", interact);
    target.removeEventListener("keydown", interact);
  };
}

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
