/** Reads an SSE response into `{event, data}` records as they arrive. */
export function sseReader(body: ReadableStream<Uint8Array>) {
  const events: { event: string; data: unknown; at: number }[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  const done = (async () => {
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) return;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data !== undefined) events.push({ event, data: JSON.parse(data), at: Date.now() });
      }
    }
  })().catch(() => undefined);
  return {
    events,
    done,
    cancel: () => reader.cancel().catch(() => undefined),
    async waitFor(pred: (e: { event: string; data: unknown }) => boolean, ms = 3000) {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const hit = events.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no matching event within ${ms} ms: ${JSON.stringify(events.map((e) => e.event))}`);
    },
  };
}
