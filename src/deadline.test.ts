import assert from "node:assert/strict";
import { test } from "node:test";
import { withDeadline } from "./deadline.js";

test("deadline cancels cooperative work and handles a late rejection", async () => {
  let received: AbortSignal | undefined;
  await assert.rejects(withDeadline(signal => {
    received = signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, 10), new RegExp("timed out"));
  assert.equal(received?.aborted, true);
});

test("request cancellation prevents starting work", async () => {
  const parent = new AbortController();
  parent.abort(new Error("disconnected"));
  let started = false;
  await assert.rejects(withDeadline(() => { started = true; }, 1000, parent.signal), new RegExp("disconnected"));
  assert.equal(started, false);
});

test("failure cancels siblings; success clears deadline", async () => {
  let failed: AbortSignal | undefined;
  await assert.rejects(withDeadline(signal => { failed = signal; throw new Error("failed"); }, 100), new RegExp("failed"));
  assert.equal(failed?.aborted, true);
  let succeeded: AbortSignal | undefined;
  assert.equal(await withDeadline(signal => { succeeded = signal; return 42; }, 10), 42);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(succeeded?.aborted, false);
});

test("in-flight request cancellation reaches work and success removes listeners", async () => {
  const parent = new AbortController();
  let received: AbortSignal | undefined;
  let ready: () => void = () => {};
  const started = new Promise<void>(resolve => { ready = resolve; });
  const pending = withDeadline(signal => {
    received = signal;
    ready();
    return new Promise<void>(() => {});
  }, 1000, parent.signal);
  await started;
  parent.abort(new Error("disconnected"));
  await assert.rejects(pending, new RegExp("disconnected"));
  assert.equal(received?.aborted, true);
  const completed = new AbortController();
  await withDeadline(signal => { received = signal; }, 1000, completed.signal);
  completed.abort();
  assert.equal(received?.aborted, false);
});
