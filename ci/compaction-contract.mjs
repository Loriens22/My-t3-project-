// Real native wire check using the exact SDK bundled in T3 0.1.0.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { OpenCode, Session } from "@opencode/client/effect";
import { SessionMessage } from "@opencode/schema/session-message";

const baseUrl = "http://127.0.0.1:4096";
const password = readFileSync("/data/opencode-server-password", "utf8").trim();
assert(password, "Owned QA credential missing");
const authorization = "Basic " + Buffer.from("opencode:" + password).toString("base64");
const work = mkdtempSync(join(tmpdir(), "oc-compaction-contract-"));
const ownedSessions = new Set();
let stage = "initialization";

async function request(method, path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) {
    const error = new Error("Owned native API request failed");
    error.status = response.status;
    throw error;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function oldClientMessages(id) {
  const program = Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const authenticated = HttpClient.mapRequest(
      http, HttpClientRequest.setHeader("Authorization", authorization));
    const client = yield* OpenCode.make({ baseUrl }).pipe(
      Effect.provideService(HttpClient.HttpClient, authenticated));
    return yield* client.message.list({ sessionID: Session.ID.make(id), order: "asc", limit: 100 });
  }).pipe(Effect.timeout("15 seconds"), Effect.provide(FetchHttpClient.layer), Effect.scoped);
  return Effect.runPromise(program);
}

async function main() {
  try {
    stage = "native-version";
    const info = await request("GET", "/api/info");
    assert.equal(info.version, "2.2.5");
    stage = "create-control";
    const created = await request("POST", "/api/session", {
      title: "Owned compatibility control", location: { directory: work } });
    const control = created.data;
    assert.equal(typeof control.id, "string");
    ownedSessions.add(control.id);
    stage = "old-client-control";
    const controlPage = await oldClientMessages(control.id);
    assert(Array.isArray(controlPage.data));

    const legacyMessage = {
      type: "compaction", id: "msg_contract_" + randomBytes(12).toString("hex"),
      time: { created: Date.now() }, status: "completed", reason: "manual",
      summary: "Owned compaction compatibility fixture.",
      recent: "Owned retained context; no user conversation data.",
    };
    stage = "legacy-schema-control";
    assert(Result.isSuccess(Schema.decodeUnknownResult(SessionMessage.Info)(legacyMessage)),
      "Legacy control fixture invalid");

    stage = "import-legacy-compaction";
    const importedId = "ses_" + randomBytes(16).toString("hex");
    ownedSessions.add(importedId);
    await request("POST", "/api/experimental/session/import", {
      info: { ...control, id: importedId, title: "Owned migrated compaction contract" },
      messages: [legacyMessage], location: { directory: work },
    });
    stage = "read-current-native-wire";
    const nativePage = await request("GET",
      "/api/session/" + encodeURIComponent(importedId) + "/message?order=asc&limit=100");
    const actual = nativePage.data.find(
      message => message.type === "compaction" && message.summary === legacyMessage.summary);
    assert(actual, "Native API did not return owned compaction");
    const contextPreserved = actual.recent === legacyMessage.recent ||
      actual.metadata?.recent === legacyMessage.recent;
    assert(contextPreserved, "Native conversion lost retained context");

    stage = "old-schema-current-wire";
    const decoded = Schema.decodeUnknownResult(SessionMessage.Info)(actual);
    const schemaAccepted = Result.isSuccess(decoded);
    const schemaFailureMentionsRecent = !schemaAccepted && /recent/i.test(String(decoded.failure));
    stage = "old-client-current-wire";
    let httpAccepted = false;
    let httpFailureMentionsRecent = false;
    try {
      const page = await oldClientMessages(importedId);
      httpAccepted = page.data.some(
        message => message.type === "compaction" && message.summary === legacyMessage.summary);
    } catch (error) {
      httpFailureMentionsRecent = /recent/i.test(String(error));
    }
    const compatible = schemaAccepted && httpAccepted;
    console.log(JSON.stringify({
      test: "actual-native-compaction-contract", nativeVersion: info.version, clientVersion: "2.0.28",
      legacySchemaControl: "passed", oldClientControl: "passed",
      controlMessageCount: controlPage.data.length, retainedContextPreserved: contextPreserved,
      actualWireHasLegacyRecent: Object.hasOwn(actual, "recent"),
      oldSchemaAcceptsActualWire: schemaAccepted, oldSchemaFailureMentionsRecent: schemaFailureMentionsRecent,
      oldClientAcceptsActualWire: httpAccepted, oldClientFailureMentionsRecent: httpFailureMentionsRecent,
      releaseGate: compatible ? "passed" : "blocked",
    }));
    if (!compatible) process.exitCode = 1;
  } finally {
    let cleanupFailures = 0;
    for (const id of ownedSessions) {
      try { await request("DELETE", "/api/session/" + encodeURIComponent(id)); }
      catch { cleanupFailures++; }
    }
    rmSync(work, { recursive: true, force: true });
    if (cleanupFailures) {
      console.error(JSON.stringify({ test: "compaction-contract-cleanup", cleanupFailures }));
      process.exitCode = 1;
    }
  }
}
main().catch(error => {
  console.error(JSON.stringify({ test: "compaction-contract", result: "setup-or-control-failed",
    stage, errorType: error?.name || "Error",
    ...(typeof error?.status === "number" ? { status: error.status } : {}) }));
  process.exitCode = 1;
});
