/**
 * POST-based SSE client. EventSource can't POST, so we use fetch + ReadableStream.
 * @param {string} url
 * @param {object} body  – will be JSON-serialised
 * @param {function} onMessage  – called with parsed JSON object per event
 * @param {AbortSignal} [signal]
 */
export async function ssePost(url, body, onMessage, signal) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} — ${await resp.text()}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";  // keep incomplete tail
    for (const ev of events) {
      const line = ev.trim();
      if (!line.startsWith("data:")) continue;
      try {
        const json = line.slice("data:".length).trim();
        onMessage(JSON.parse(json));
      } catch {
        // skip malformed
      }
    }
  }
}

/**
 * POST form-data SSE (for /api/ingest which uses Form fields).
 */
export async function ssePostForm(url, formData, onMessage, signal) {
  const resp = await fetch(url, {
    method: "POST",
    body: formData,
    signal,
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} — ${await resp.text()}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const ev of events) {
      const line = ev.trim();
      if (!line.startsWith("data:")) continue;
      try {
        const json = line.slice("data:".length).trim();
        onMessage(JSON.parse(json));
      } catch {
        // skip malformed
      }
    }
  }
}
