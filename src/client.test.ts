import { afterEach, expect, test } from "bun:test";
import { showBotDetectedPopup, startNoSkrapBeacon } from "./client";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

function browser() {
  const listeners = new Map<string, Set<EventListener>>();
  const requests: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const target = {
    addEventListener(type: string, listener: EventListener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(null, { status: 204 });
  }, { preconnect: originalFetch.preconnect });
  const fire = (type: string, trusted = true) => {
    const event = new Proxy(new Event(type), {
      get(target, key) { return key === "isTrusted" ? trusted : Reflect.get(target, key, target); },
    });
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return { fire, requests, listeners };
}

test("beacon sends only trusted interactions and includes the signed token", () => {
  const { fire, requests } = browser();
  const stop = startNoSkrapBeacon({ token: "signed-token" });
  expect(requests.length).toBe(0);
  fire("pointerdown", false);
  expect(requests.length).toBe(0);
  fire("keydown");
  expect(requests).toEqual([{
    input: "/api/noskrap/telemetry",
    init: {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", "x-noskrap-telemetry": "signed-token" },
      body: '{"interacted":true}',
    },
  }]);
  stop();
});

test("beacon keeps listeners and resends on interaction after five minutes", () => {
  let now = 0;
  Date.now = () => now;
  const { fire, requests, listeners } = browser();
  const stop = startNoSkrapBeacon({ token: "signed-token" });
  fire("pointerdown");
  now = 299999;
  fire("keydown");
  expect(requests.length).toBe(1);
  now = 300000;
  fire("keydown");
  expect(requests.length).toBe(2);
  now = 600000;
  fire("pointerdown");
  expect(requests.length).toBe(3);
  stop();
  stop();
  now = 900000;
  fire("pointerdown");
  fire("keydown");
  expect(requests.length).toBe(3);
  expect(listeners.get("pointerdown")?.size).toBe(0);
  expect(listeners.get("keydown")?.size).toBe(0);
});

test("beacon supports cleanup and remount with a new token and custom path", () => {
  const { fire, requests } = browser();
  startNoSkrapBeacon({ token: "old-token" })();
  const stop = startNoSkrapBeacon({ token: "new-token", endpoint: "/base/telemetry" });
  fire("pointerdown");
  expect(requests.length).toBe(1);
  expect(requests[0].input).toBe("/base/telemetry");
  expect(new Headers(requests[0].init?.headers).get("x-noskrap-telemetry")).toBe("new-token");
  stop();
});

test("beacon handles transport rejection without interrupting interaction", async () => {
  const { fire } = browser();
  globalThis.fetch = Object.assign(async () => { throw new Error("offline"); }, { preconnect: originalFetch.preconnect });
  const stop = startNoSkrapBeacon({ token: "signed-token" });
  fire("pointerdown");
  await Promise.resolve();
  stop();
});

test("beacon rejects empty tokens and endpoints that can leak the token", () => {
  browser();
  expect(() => startNoSkrapBeacon({ token: "" })).toThrow(TypeError);
  for (const endpoint of ["https://other.test/", "//other.test/", "/\\other.test/", "relative", "/ path", "/path#fragment", "/\n/other.test"]) {
    expect(() => startNoSkrapBeacon({ token: "signed-token", endpoint })).toThrow(TypeError);
  }
});

test("beacon is safe to import and call during server rendering", () => {
  Reflect.deleteProperty(globalThis, "window");
  const stop = startNoSkrapBeacon({ token: "signed-token" });
  stop();
});

test("shows popup for challenge and block decisions", () => {
  const messages: string[] = [];
  const show = (message: string) => messages.push(message);

  expect(showBotDetectedPopup("challenge", { show })).toBe(true);
  expect(showBotDetectedPopup({ decision: "block" }, { show })).toBe(true);
  expect(messages).toEqual(["Bot detected.", "Bot detected."]);
});

test("does not show popup for allow or observe decisions", () => {
  const messages: string[] = [];
  const show = (message: string) => messages.push(message);

  expect(showBotDetectedPopup("allow", { show })).toBe(false);
  expect(showBotDetectedPopup({ decision: "observe" }, { show })).toBe(false);
  expect(messages).toEqual([]);
});

test("uses custom message", () => {
  const messages: string[] = [];

  expect(
    showBotDetectedPopup("block", {
      message: "Suspicious traffic detected.",
      show: (message) => messages.push(message),
    }),
  ).toBe(true);
  expect(messages).toEqual(["Suspicious traffic detected."]);
});
