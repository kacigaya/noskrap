import { expect, test } from "bun:test";
import { withDeadline } from "./deadline";

test("deadline cancels cooperative work and handles a late rejection", async () => {
  let received: AbortSignal | undefined;
  await expect(withDeadline(signal => {
    received = signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, 10)).rejects.toThrow("timed out");
  expect(received?.aborted).toBe(true);
});

test("request cancellation prevents starting work", async () => {
  const parent = new AbortController();
  parent.abort(new Error("disconnected"));
  let started = false;
  await expect(withDeadline(() => { started = true; }, 1000, parent.signal)).rejects.toThrow("disconnected");
  expect(started).toBe(false);
});

test("failure cancels siblings; success clears deadline", async () => {
  let failed: AbortSignal | undefined;
  await expect(withDeadline(signal => { failed = signal; throw new Error("failed"); }, 100)).rejects.toThrow("failed");
  expect(failed?.aborted).toBe(true);
  let succeeded: AbortSignal | undefined;
  expect(await withDeadline(signal => { succeeded = signal; return 42; }, 10)).toBe(42);
  await Bun.sleep(20);
  expect(succeeded?.aborted).toBe(false);
});
