import { readBodyWithLimit } from "./request-body.js";

export interface TurnstileVerifierOptions {
  secretKey: string;
  expectedHostname: string;
  expectedAction?: string;
}

export function createTurnstileVerifier(options: TurnstileVerifierOptions) {
  const { secretKey, expectedHostname, expectedAction } = options;
  if (typeof secretKey !== "string" || !secretKey.trim()) {
    throw new TypeError("secretKey must be a non-empty string");
  }
  if (typeof expectedHostname !== "string" || !expectedHostname.trim() ||
    /[\s/:?#\\]/.test(expectedHostname)) {
    throw new TypeError("expectedHostname must be a hostname without a scheme or port");
  }
  if (expectedAction !== undefined &&
    (typeof expectedAction !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(expectedAction))) {
    throw new TypeError("expectedAction must contain 1 to 32 letters, digits, underscores, or hyphens");
  }
  const hostname = expectedHostname.toLowerCase();

  return async function verifyTurnstile(request: Request, signal: AbortSignal): Promise<boolean> {
    if (request.method !== "POST") return false;
    if (Number(request.headers.get("content-length")) > 4096) return false;
    const raw = await readBodyWithLimit(request, 4096, signal);
    if (raw === null) return false;
    signal.throwIfAborted();

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return false;
    }
    if (typeof payload !== "object" || payload === null || !("token" in payload) ||
      typeof payload.token !== "string" || !payload.token.trim() || payload.token.length > 2048) {
      return false;
    }

    // Use only the provider's verification result. Request headers cannot prove an IP or host.
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: secretKey, response: payload.token }),
      signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error("Turnstile verification unavailable");
    const result: unknown = await response.json();
    return typeof result === "object" && result !== null &&
      "success" in result && result.success === true &&
      "hostname" in result && typeof result.hostname === "string" && result.hostname.toLowerCase() === hostname &&
      (expectedAction === undefined || ("action" in result && result.action === expectedAction));
  };
}
