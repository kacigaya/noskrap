import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerifiedCrawlerVerifier } from "./crawlers.js";

function request(agent = "Googlebot/2.1") {
  return new Request("https://example.test/", { headers: { "user-agent": agent } });
}

test("crawler verification requires an approved PTR suffix and matching forward address", async () => {
  for (const [agent, host, address, expected] of [
    ["Googlebot/2.1", "crawl.googlebot.com", "192.0.2.1", true],
    ["bingbot/2.0", "crawler.search.msn.com", "192.0.2.1", true],
    ["Googlebot/2.1", "CRAWL.GOOGLEBOT.COM.", "192.0.2.1", true],
    ["Googlebot/2.1", "crawl.googlebot.com.evil.test", "192.0.2.1", false],
    ["Googlebot/2.1", "fakegooglebot.com", "192.0.2.1", false],
    ["Googlebot/2.1", "crawl.googlebot.com", "192.0.2.2", false],
    ["Googlebot/2.1", "crawler.search.msn.com", "192.0.2.1", false],
    ["Mozilla/5.0", "crawl.googlebot.com", "192.0.2.1", false],
  ] as const) {
    const verify = createVerifiedCrawlerVerifier({ getClientIp: () => "192.0.2.1", resolver: () => ({
      reverse: async () => [host], resolve4: async () => [address], resolve6: async () => [], cancel() {},
    }) });
    assert.equal(await verify(request(agent), new AbortController().signal), expected);
  }
});

test("crawler DNS results are bounded, cached, and support canonical IPv6 addresses", async () => {
  let calls = 0;
  const verify = createVerifiedCrawlerVerifier({ getClientIp: () => "2001:db8::1", resolver: () => ({
    reverse: async () => { calls++; return ["crawler.googlebot.com"]; }, resolve4: async () => [],
    resolve6: async () => ["2001:0db8:0:0:0:0:0:1"], cancel() {},
  }) });
  const signal = new AbortController().signal;
  assert.equal(await verify(request(), signal), true);
  assert.equal(await verify(request(), signal), true);
  assert.equal(calls, 1);
});

test("crawler checks reject missing IPs and cancel DNS on request abort", async () => {
  let started: () => void = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  let cancelled = false;
  let rejectDns: (reason: Error) => void = () => {};
  const verify = createVerifiedCrawlerVerifier({ getClientIp: () => "192.0.2.1", resolver: () => ({
    reverse: () => { started(); return new Promise<string[]>((_resolve, reject) => { rejectDns = reject; }); },
    resolve4: async () => [], resolve6: async () => [],
    cancel() { cancelled = true; rejectDns(new Error("DNS cancelled")); },
  }) });
  const controller = new AbortController();
  const pending = verify(request(), controller.signal);
  await ready;
  controller.abort(new Error("disconnected"));
  await assert.rejects(pending, /disconnected/);
  assert.equal(cancelled, true);
  const missing = createVerifiedCrawlerVerifier({ getClientIp: () => undefined });
  assert.equal(await missing(request(), new AbortController().signal), false);
});

test("DNS errors do not verify a crawler", async () => {
  const verify = createVerifiedCrawlerVerifier({ getClientIp: () => "192.0.2.1", resolver: () => ({
    reverse: async () => { throw new Error("unavailable"); }, resolve4: async () => [], resolve6: async () => [], cancel() {},
  }) });
  assert.equal(await verify(request(), new AbortController().signal), false);
});
