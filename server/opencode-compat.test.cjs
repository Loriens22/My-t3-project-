const test = require("node:test");
const assert = require("node:assert/strict");
const { adaptMessage, adaptPage, adaptEvent, adaptFrame, eventStream, wrapFetch, install } = require("./opencode-compat.cjs");
const url = "http://127.0.0.1:4096/api/session/ses_owned/message?order=asc&limit=100";

test("legacy context is copied without altering native messages or replay data", () => {
  const original = { type: "compaction", id: "msg_owned", status: "completed", summary: "summary",
    metadata: { recent: "retained original context", other: 42 }, native: { messages: ["owned"] } };
  const before = structuredClone(original);
  const result = adaptPage({ data: [original], next: "cursor" });
  assert.equal(result.data[0].recent, before.metadata.recent);
  const { recent, ...unchanged } = result.data[0];
  assert.deepEqual(unchanged, before);
  assert.deepEqual(original, before);
  assert.equal(result.next, "cursor");
});
test("native compactions without legacy text use the old valid empty field", () => {
  for (const status of ["running", "completed"]) {
    assert.equal(adaptMessage({ type: "compaction", status, summary: "kept" }).recent, "");
  }
});
test("existing invalid fields, failed compactions and ordinary content are preserved", () => {
  for (const original of [{ type: "compaction", status: "completed", recent: null },
    { type: "compaction", status: "failed" }, { type: "user", content: "recent" }]) {
    assert.equal(adaptMessage(original), original);
  }
});
test("SSE adaptation preserves identity, summary and durable metadata", () => {
  const original = { type: "session.compaction.ended", id: "evt_owned", durable: { version: 1 },
    data: { sessionID: "ses_owned", text: "Истинско обобщение 😀", native: { kept: true } } };
  const adapted = adaptEvent(original);
  assert.equal(adapted.data.recent, "");
  const { recent, ...data } = adapted.data;
  assert.deepEqual(data, original.data);
  assert.equal(adapted.id, original.id);
  assert.deepEqual(adapted.durable, original.durable);
  const frame = "id: evt_owned\r\ndata: " + JSON.stringify(original) + "\r\nretry: 15000";
  const result = adaptFrame(frame);
  assert(result.startsWith("id: evt_owned\r\n"));
  assert(result.endsWith("\r\nretry: 15000"));
  assert.equal(JSON.parse(result.split("\r\n")[1].slice(6)).data.recent, "");
});
test("stream adaptation survives byte splits and preserves heartbeat and unrelated events", async () => {
  const input = ': heartbeat\n\ndata: {"type":"server.connected","data":{}}\n\n' +
    'data: {"type":"session.compaction.ended","data":{"text":"Обобщение 😀"}}\n\n';
  const bytes = new TextEncoder().encode(input);
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }).pipeThrough(eventStream());
  const output = await new Response(stream).text();
  assert(output.startsWith(': heartbeat\n\ndata: {"type":"server.connected","data":{}}\n\n'));
  assert.equal(JSON.parse(output.trim().split("\n\n").at(-1).slice(6)).data.text, "Обобщение 😀");
  assert(output.includes('"recent":""'));
});
test("large unrelated frames stream unchanged and the next compaction is still adapted", async () => {
  const first = 'data: ' + JSON.stringify({ type: "session.message", data: { text: "x".repeat(500) + " 😀 Я ".repeat(150) } }) + "\n\n";
  const last = 'data: {"type":"session.compaction.started","data":{"reason":"manual"}}\n\n';
  const bytes = new TextEncoder().encode(first + last);
  const stream = new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
    controller.close();
  } }).pipeThrough(eventStream(128));
  const result = await new Response(stream).text();
  assert(result.startsWith(first));
  assert.equal(JSON.parse(result.slice(first.length).trim().slice(6)).data.recent, "");
});
test("only owned native GET message responses are changed and authentication is passed intact", async () => {
  const options = { headers: { Authorization: "Basic ci-owned-credential" } };
  let actualInput, actualOptions;
  const original = async (input, init) => {
    actualInput = input; actualOptions = init;
    return new Response(JSON.stringify({ data: [{ type: "compaction", status: "completed", summary: "kept" }] }),
      { headers: { "content-type": "application/json", "content-length": "1", etag: "obsolete" } });
  };
  const response = await wrapFetch(original)(url, options);
  assert.equal(actualInput, url);
  assert.equal(actualOptions, options);
  assert.equal((await response.json()).data[0].recent, "");
  assert.equal(response.headers.has("content-length"), false);
  assert.equal(response.headers.has("etag"), false);
  for (const target of ["https://api.moonshot.ai/v1/chat/completions",
      "http://127.0.0.1:4097/api/session/ses_owned/message",
      "http://127.0.0.1:4096/api/model"]) {
    const sentinel = new Response("untouched");
    assert.equal(await wrapFetch(async () => sentinel)(target), sentinel);
  }
});
test("provider quota errors and POST requests retain the original response and body", async () => {
  const body = '{"error":{"code":"provider.quota","message":"Free usage limit reached"}}';
  const failed = new Response(body, { status: 429, headers: { "content-type": "application/json" } });
  assert.equal(await wrapFetch(async () => failed)(url), failed);
  assert.equal(await failed.text(), body);
  const post = new Response("owned POST");
  assert.equal(await wrapFetch(async () => post)(url, { method: "POST", body: "unchanged" }), post);
});
test("installing twice leaves a single wrapper", () => {
  const first = globalThis.fetch;
  install();
  assert.equal(globalThis.fetch, first);
});
