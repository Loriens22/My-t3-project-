// Compatibility view for T3 0.1's pinned OpenCode SDK. Native storage, requests,
// model traffic, credentials and quota errors remain owned by OpenCode.
"use strict";

const TYPES = new Set(["session.compaction.started", "session.compaction.ended"]);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function adaptMessage(message) {
  if (!message || message.type !== "compaction" ||
      !["running", "completed"].includes(message.status) || has(message, "recent")) return message;
  return { ...message, recent: typeof message.metadata?.recent === "string" ? message.metadata.recent : "" };
}

function adaptPage(page) {
  if (!page || typeof page !== "object") return page;
  if (Array.isArray(page.data)) {
    const data = page.data.map(adaptMessage);
    return data.some((value, index) => value !== page.data[index]) ? { ...page, data } : page;
  }
  const data = adaptMessage(page.data);
  return data === page.data ? page : { ...page, data };
}

function adaptEvent(event) {
  if (!event || !TYPES.has(event.type) || !event.data ||
      typeof event.data !== "object" || Array.isArray(event.data) || has(event.data, "recent")) return event;
  return { ...event, data: { ...event.data, recent: "" } };
}

function adaptFrame(frame) {
  // Native event-feed uses JSON.stringify; ordinary token/tool events need no second JSON parse.
  if (!frame.includes('"session.compaction.started"') && !frame.includes('"session.compaction.ended"')) return frame;
  const lines = frame.split(/\r?\n/);
  const data = lines.filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).replace(/^ /, "")).join("\n");
  if (!data) return frame;
  let event;
  try { event = JSON.parse(data); } catch { return frame; }
  const next = adaptEvent(event);
  if (next === event) return frame;
  let inserted = false;
  return lines.flatMap(line => {
    if (!line.startsWith("data:")) return [line];
    if (inserted) return [];
    inserted = true;
    return ["data: " + JSON.stringify(next)];
  }).join(frame.includes("\r\n") ? "\r\n" : "\n");
}

function eventStream(maxBuffered = 4 * 1024 * 1024) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let passthrough = false;
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(pending);
        if (!separator) break;
        const frame = pending.slice(0, separator.index);
        const delimiter = separator[0];
        pending = pending.slice(separator.index + delimiter.length);
        controller.enqueue(encoder.encode((passthrough ? frame : adaptFrame(frame)) + delimiter));
        passthrough = false;
      }
      // Large unrelated frames (e.g. image payloads) pass through unchanged
      // rather than accumulating an unbounded buffer in the T3 process.
      if (pending.length > maxBuffered) {
        let cut = pending.length - 3;
        // TextEncoder must never receive half of a UTF-16 surrogate pair.
        if (cut > 0 && /[\uD800-\uDBFF]/.test(pending[cut - 1]) &&
            /[\uDC00-\uDFFF]/.test(pending[cut])) cut--;
        controller.enqueue(encoder.encode(pending.slice(0, cut)));
        pending = pending.slice(cut);
        passthrough = true;
      }
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(pending));
    },
  });
}

function replacement(response, body) {
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "etag", "content-md5", "digest"]) headers.delete(name);
  const result = new Response(body, { status: response.status, statusText: response.statusText, headers });
  // Fetch consumers retain the original response identity/diagnostic metadata.
  for (const name of ["url", "redirected", "type"]) {
    Object.defineProperty(result, name, { value: response[name], configurable: true });
  }
  return result;
}

function wrapFetch(original) {
  return async function compatibleFetch(input, init) {
    const response = await original(input, init);
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url); }
    catch { return response; }
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    if (method !== "GET" || url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
        url.port !== "4096" || !response.ok || !response.body) return response;
    const contentType = response.headers.get("content-type") || "";
    if (url.pathname === "/api/event" && contentType.includes("text/event-stream")) {
      return replacement(response, response.body.pipeThrough(eventStream()));
    }
    if (/^\/api\/session\/[^/]+\/message(?:\/[^/]+)?\/?$/.test(url.pathname) &&
        contentType.includes("application/json")) {
      let text = await response.text();
      let page;
      try { page = JSON.parse(text); }
      catch { return replacement(response, text); }
      const next = adaptPage(page);
      if (next === page) return replacement(response, text);
      text = null;
      return replacement(response, JSON.stringify(next));
    }
    return response;
  };
}

function install() {
  const marker = Symbol.for("t3.opencode.legacy-compaction-fetch");
  if (globalThis[marker]) return;
  if (typeof globalThis.fetch !== "function") throw new Error("T3 requires native Fetch support");
  globalThis.fetch = wrapFetch(globalThis.fetch.bind(globalThis));
  globalThis[marker] = true;
}

exports.adaptMessage = adaptMessage;
exports.adaptPage = adaptPage;
exports.adaptEvent = adaptEvent;
exports.adaptFrame = adaptFrame;
exports.eventStream = eventStream;
exports.wrapFetch = wrapFetch;
exports.install = install;
install();
