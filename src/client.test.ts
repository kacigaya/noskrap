import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { showBotDetectedPopup, startNoSkrapBeacon } from "./client.js";

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
  assert.equal(requests.length, 0);
  fire("pointerdown", false);
  assert.equal(requests.length, 0);
  fire("keydown");
  assert.deepEqual(requests, [{
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
  assert.equal(requests.length, 1);
  now = 300000;
  fire("keydown");
  assert.equal(requests.length, 2);
  now = 600000;
  fire("pointerdown");
  assert.equal(requests.length, 3);
  stop();
  stop();
  now = 900000;
  fire("pointerdown");
  fire("keydown");
  assert.equal(requests.length, 3);
  assert.equal(listeners.get("pointerdown")?.size, 0);
  assert.equal(listeners.get("keydown")?.size, 0);
});

test("beacon supports cleanup and remount with a new token and custom path", () => {
  const { fire, requests } = browser();
  startNoSkrapBeacon({ token: "old-token" })();
  const stop = startNoSkrapBeacon({ token: "new-token", endpoint: "/base/telemetry" });
  fire("pointerdown");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, "/base/telemetry");
  assert.equal(new Headers(requests[0].init?.headers).get("x-noskrap-telemetry"), "new-token");
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
  assert.throws(() => startNoSkrapBeacon({ token: "" }), TypeError);
  for (const endpoint of ["https://other.test/", "//other.test/", "/\\other.test/", "relative", "/ path", "/path#fragment", "/\n/other.test"]) {
    assert.throws(() => startNoSkrapBeacon({ token: "signed-token", endpoint }), TypeError);
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

  assert.equal(showBotDetectedPopup("challenge", { show }), true);
  assert.equal(showBotDetectedPopup({ decision: "block" }, { show }), true);
  assert.deepEqual(messages, ["Bot detected.", "Bot detected."]);
});

test("does not show popup for allow or observe decisions", () => {
  const messages: string[] = [];
  const show = (message: string) => messages.push(message);

  assert.equal(showBotDetectedPopup("allow", { show }), false);
  assert.equal(showBotDetectedPopup({ decision: "observe" }, { show }), false);
  assert.deepEqual(messages, []);
});

test("uses custom message", () => {
  const messages: string[] = [];

  assert.equal(showBotDetectedPopup("block", {
      message: "Suspicious traffic detected.",
      show: (message) => messages.push(message),
    }), true);
  assert.deepEqual(messages, ["Suspicious traffic detected."]);
});
