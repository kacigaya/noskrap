// `content-length` is client-supplied and absent entirely on chunked requests,
// so it cannot be the only guard. Read the stream and give up once the cap is
// passed, rather than buffering whatever the client decides to send.
export async function readBodyWithLimit(
  request: Request,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();

  signal.throwIfAborted();
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }

  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

