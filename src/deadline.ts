// A deadline bounds waiting; cancellation also reaches cooperative transports.
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(new Error("operation timed out")), timeoutMs);
  let rejectAbort: () => void = () => {};
  try {
    if (parent?.aborted) abort();
    else parent?.addEventListener("abort", abort, { once: true });
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      cancelled,
    ]);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}

export function validateDeadline(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) {
    throw new TypeError(`${name} must be an integer from 1 to 2147483647`);
  }
}
