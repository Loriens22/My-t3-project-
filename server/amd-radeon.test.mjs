import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { PassThrough } from "node:stream";
import test from "node:test";
import { amdRadeonCatalog, amdRadeonDiscoveryProviders, configureAmdRadeon } from "./amd-radeon.mjs";
import { configureInferenceRoutes } from "./inference-routing.mjs";

const providerID = "amd-radeon";
const baseURL = "https://developer.amd.com.cn/radeon/api/v1";
const flash = "DeepSeek-V4.1-Flash";
const next = "Qwen3.8-Flash-Next";
const qwen = "Qwen3.8-27B";
const glm = "GLM-5.3-Flash";
const mimo = "MiMo-V2.6-Flash";
const ids = [flash, next, qwen, glm, mimo];
const environment = { AMD_RADEON_API_KEY: " private-owner-key " };
const live = { reason: "ready", modelIds: ids, contextLimits: Object.fromEntries(ids.map(id => [id, 65536])) };
const row = id => ({ id, free: true, context_length: 262144,
  supported_parameters: ["temperature", "max_tokens", "stream", "tools"],
  providers: [{ tools: true, streaming: true }],
  pricing: { prompt: "0.00000014", completion: "0.00000028" },
});
const native = id => ({ providerID, id, type: "chat", enabled: true, status: "experimental",
  capabilities: { tools: true }, limit: { context: 65536, output: 16384 } });

test("AMD inference uses the shared queue without changing identity, credentials or reasoning settings", () => {
  const config = {};
  configureAmdRadeon(config, ids.map(native), environment, live);
  const before = structuredClone(config);
  const routes = configureInferenceRoutes(config, ids.map(native));
  assert.deepEqual(Object.values(routes), [baseURL]);
  for (const id of ids) {
    const entry = config.providers[providerID].models[id];
    assert.match(entry.settings.baseURL, /^http:\/\/127\.0\.0\.1:4098\/[a-f0-9]{16}$/u);
    delete entry.settings.baseURL;
  }
  assert.deepEqual(config, before);
});

test("AMD queue rejects another host, global AMD service, changed path, URL credentials and query secrets", () => {
  for (const endpoint of ["https://api.tokenlab.amd.com/v1", "https://developer.amd.com.cn/other/api/v1",
    "http://developer.amd.com.cn/radeon/api/v1", "https://developer.amd.com.cn.evil.invalid/radeon/api/v1",
    "https://secret@developer.amd.com.cn/radeon/api/v1", baseURL + "?key=secret", baseURL + "#secret"]) {
    const config = {};
    configureAmdRadeon(config, [native(flash)], environment, live);
    assert.throws(() => configureInferenceRoutes(config, [{ ...native(flash), baseURL: endpoint }]),
      error => /Unrecognized/u.test(error.message) && !error.message.includes("secret"));
  }
});

test("only the selected China key enables AMD discovery; global/other credentials cannot activate it", async () => {
  const noKeys = [null, {}, { AMD_API_KEY: "global-key", RADEON_API_KEY: "different-name", NVIDIA_API_KEY: "other-key" },
    { AMD_RADEON_API_KEY: "  " }, { AMD_RADEON_API_KEY: "key\r\nInjected: value" }];
  for (const env of noKeys) {
    assert.deepEqual(amdRadeonDiscoveryProviders(env), []);
    let called = false;
    assert.deepEqual(await amdRadeonCatalog(env, async () => { called = true; }),
      { reason: "missing_key", modelIds: [] });
    assert.equal(called, false);
  }
  assert.deepEqual(amdRadeonDiscoveryProviders(environment), [providerID]);
});

test("catalog authentication has a fixed official destination, no redirects, a deadline and size bound", async () => {
  let calls = 0;
  const catalog = await amdRadeonCatalog({ ...environment, AMD_RADEON_BASE_URL: "https://untrusted.invalid/v1" },
    async (url, options) => {
      calls++;
      assert.equal(url, `${baseURL}/models`);
      assert.deepEqual(options.headers, { accept: "application/json", authorization: "Bearer private-owner-key" });
      assert.equal(options.redirect, "error");
      assert.equal(options.timeout, 10000);
      assert.equal(options.maxBytes, 1024 * 1024);
      return { status: 200, body: { data: ids.map(row) } };
    });
  assert.equal(calls, 1);
  assert.deepEqual(catalog, live);
  assert.equal(JSON.stringify(catalog).includes("private-owner-key"), false);
  assert.equal(JSON.stringify(catalog).includes("pricing"), false);
});

test("unreviewed aliases, paid drift, missing capabilities and contradictory duplicates fail closed", async () => {
  const bad = [
    { ...row(flash), id: `${flash}-1017` },
    { ...row(qwen), id: "Qwen3.8-27B:paid-backend" },
    { ...row(flash), free: false }, { ...row(flash), free: undefined },
    { ...row(flash), providers: [{ tools: false, streaming: true }] },
    { ...row(flash), providers: [{ tools: true, streaming: false }] },
    { ...row(flash), providers: [] }, { ...row(flash), providers: undefined },
    { ...row(flash), supported_parameters: ["stream", "max_tokens"] },
    { ...row(flash), supported_parameters: ["tools", "max_tokens"] },
    { ...row(flash), supported_parameters: ["tools", "stream"] },
    { ...row(flash), context_length: 0 }, { ...row(flash), context_length: "262144" }, null,
  ];
  for (const model of bad) {
    assert.deepEqual(await amdRadeonCatalog(environment, async () => ({ status: 200, body: { data: [model] } })),
      { reason: "catalog_unavailable", modelIds: [] });
  }
  assert.deepEqual(await amdRadeonCatalog(environment, async () => ({ status: 200,
    body: { data: [row(flash), { ...row(flash), free: false }, row(qwen), null] } })),
  { reason: "ready", modelIds: [qwen], contextLimits: { [qwen]: 65536 } });
});

test("only sanitized metadata survives discovery; runtime context reductions are retained", async () => {
  const catalog = await amdRadeonCatalog(environment, async () => ({ status: 200, body: { data: [
    { ...row(flash), context_length: 32768, description: "private-owner-key" },
    row(qwen), row(qwen), { id: "unreviewed" },
  ] } }));
  assert.deepEqual(catalog, { reason: "ready", modelIds: [flash, qwen],
    contextLimits: { [flash]: 32768, [qwen]: 65536 } });
});

test("unauthorized, redirected, malformed, empty and thrown catalog responses never expose error bodies", async () => {
  for (const response of [{ status: 301, body: { location: "https://untrusted.invalid" } },
    { status: 401, body: { error: "private-owner-key" } }, { status: 429 }, { status: 500 },
    { status: 200, body: { data: [] } }, { status: 200, body: {} }, undefined]) {
    assert.deepEqual(await amdRadeonCatalog(environment, async () => response),
      { reason: "catalog_unavailable", modelIds: [] });
  }
  assert.deepEqual(await amdRadeonCatalog(environment, async () => { throw Error("private-owner-key"); }),
    { reason: "catalog_unavailable", modelIds: [] });
});

function transport(t, { status = 200, chunks, error, stall = false } = {}) {
  const requests = [];
  const request = new EventEmitter();
  request.destroyed = false;
  request.destroy = () => { request.destroyed = true; };
  const response = new PassThrough();
  response.statusCode = status;
  t.mock.method(https, "get", (url, options, callback) => {
    requests.push({ url, options });
    process.nextTick(() => {
      if (stall) return;
      if (error) { request.emit("error", new Error(error)); return; }
      callback(response);
      for (const chunk of chunks ?? [Buffer.from(JSON.stringify({ data: ids.map(row) }))]) {
        response.write(chunk);
      }
      response.end();
    });
    return request;
  });
  return { requests, request, response };
}

test("real catalog transport authenticates one HTTPS request and closes its resources", async t => {
  const captured = transport(t);
  assert.deepEqual(await amdRadeonCatalog(environment), live);
  assert.equal(captured.requests.length, 1);
  assert.equal(captured.requests[0].url, `${baseURL}/models`);
  assert.equal(captured.requests[0].options.headers.authorization, "Bearer private-owner-key");
  assert.equal(captured.request.destroyed, true);
  assert.equal(captured.response.destroyed, true);
});

test("real transport never follows an authentication redirect", async t => {
  const captured = transport(t, { status: 302 });
  captured.response.headers = { location: "https://untrusted.invalid/steal" };
  assert.deepEqual(await amdRadeonCatalog(environment), { reason: "catalog_unavailable", modelIds: [] });
  assert.equal(captured.requests.length, 1);
  assert.equal(captured.request.destroyed, true);
});

test("real transport rejects oversized UTF-8 bytes and malformed JSON", async t => {
  await t.test("byte bound", async t => {
    const captured = transport(t, { chunks: [Buffer.from("é".repeat(600000))] });
    assert.deepEqual(await amdRadeonCatalog(environment), { reason: "catalog_unavailable", modelIds: [] });
    assert.equal(captured.request.destroyed, true);
  });
  await t.test("invalid JSON", async t => {
    transport(t, { chunks: [Buffer.from("private-owner-key <html>bad gateway</html>")] });
    assert.deepEqual(await amdRadeonCatalog(environment), { reason: "catalog_unavailable", modelIds: [] });
  });
  await t.test("socket failure", async t => {
    transport(t, { error: "private-owner-key" });
    assert.deepEqual(await amdRadeonCatalog(environment), { reason: "catalog_unavailable", modelIds: [] });
  });
});

test("an unresponsive real transport is stopped at its total deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const captured = transport(t, { stall: true });
  const pending = amdRadeonCatalog(environment);
  t.mock.timers.tick(10000);
  assert.deepEqual(await pending, { reason: "catalog_unavailable", modelIds: [] });
  assert.equal(captured.request.destroyed, true);
});

test("explicit discovery seeds exact native V2 definitions without embedding credentials", () => {
  const config = { enabled_providers: ["nvidia", "opencode"] };
  const status = configureAmdRadeon(config, [], environment, live, { seedDiscovery: true });
  assert.equal(status.modelCount, 5);
  assert.equal(status.billing, "free_trial_points");
  assert.equal(status.keyVariable, "AMD_RADEON_API_KEY");
  assert.deepEqual(config.enabled_providers, ["nvidia", "opencode", providerID]);
  assert.deepEqual(config.providers[providerID].env, ["AMD_RADEON_API_KEY"]);
  assert.equal(config.providers[providerID].settings.baseURL, baseURL);
  for (const id of ids) {
    const model = config.providers[providerID].models[id];
    assert.equal(model.disabled, false);
    assert.equal(model.modelID, id);
    assert.equal(model.package, "@opencode/ai/providers/openai-compatible");
    assert.deepEqual(model.compatibility, { reasoningField: "reasoning", requireReasoning: true, maxTokensField: "max_tokens" });
    assert.deepEqual(model.capabilities.input, ["text"]);
    assert.deepEqual(model.capabilities.output, ["text"]);
    assert.equal(model.capabilities.tools, true);
    assert.deepEqual(model.limit, { context: 65536, output: 16384 });
    assert.match(model.name, /free trial/u);
    assert.deepEqual(model.cost, { input: 0, output: 0, cache: { read: 0, write: 0 } });
  }
  assert.equal(Object.hasOwn(config.providers[providerID].models, `${flash}-1017`), false);
  assert.equal(JSON.stringify(config).includes("private-owner-key"), false);
});

test("model efforts match the host rather than generic high/xhigh defaults", () => {
  const config = {};
  configureAmdRadeon(config, [], environment, live, { seedDiscovery: true });
  const models = config.providers[providerID].models;
  assert.equal(models[flash].settings.reasoningEffort, "none");
  assert.equal(models[flash].capabilities.reasoning.toggle, true);
  assert.equal(models[next].settings.reasoningEffort, "low");
  assert.deepEqual(models[next].capabilities.reasoning.effort, ["low", "medium", "xhigh"]);
  assert.equal(models[next].capabilities.reasoning.toggle, true);
  assert.equal(models[qwen].settings.reasoningEffort, "low");
  assert.deepEqual(models[qwen].capabilities.reasoning.effort, ["low", "medium", "xhigh"]);
  assert.equal(models[qwen].capabilities.reasoning.toggle, undefined);
  assert.equal(models[glm].settings.reasoningEffort, "low");
  assert.deepEqual(models[glm].capabilities.reasoning.effort, ["low", "medium", "high"]);
  assert.equal(models[glm].capabilities.reasoning.toggle, undefined);
  assert.deepEqual(models[mimo].settings, {});
  assert.deepEqual(models[mimo].capabilities.reasoning, { supported: true });
});

test("final runtime configuration requires a current native chat/tool model with usable limits", () => {
  const config = {};
  const status = configureAmdRadeon(config, [native(flash), { ...native(qwen), capabilities: { tools: false } }], environment, live);
  assert.equal(status.modelCount, 1);
  assert.equal(config.providers[providerID].models[qwen].disabled, true);
  assert.equal(config.providers[providerID].models[flash].disabled, false);
  for (const override of [{ enabled: false }, { status: "deprecated" }, { status: "retired" },
    { type: "image" }, { capabilities: { tools: "true" } }, { capabilities: {} },
    { limit: { context: 0, output: 16384 } }, { limit: { context: 65536, output: 0 } },
    { limit: { context: 65536, output: "16384" } }]) {
    assert.equal(configureAmdRadeon({}, [{ ...native(flash), ...override }], environment, live).enabled, false);
  }
  for (const nativeCatalog of [[], null, {}, [{ ...native(flash), providerID: "opencode" }]]) {
    assert.equal(configureAmdRadeon({}, nativeCatalog, environment, live).enabled, false);
  }
  assert.equal(configureAmdRadeon({}, [], environment, live, { seedDiscovery: "true" }).enabled, false,
    "Only the explicit boolean discovery flag may bypass native metadata");
});

test("operator limits clamp to both live hosted context and smaller native limits", () => {
  const config = {};
  configureAmdRadeon(config, [{ ...native(flash), limit: { context: 24576, output: 4096 } }], environment,
    { reason: "ready", modelIds: [flash], contextLimits: { [flash]: 32768 } });
  assert.deepEqual(config.providers[providerID].models[flash].limit, { context: 24576, output: 4096 });
});

test("missing key, current catalog or native catalog disables stale AMD routes while keeping other providers", () => {
  for (const [env, catalog, nativeCatalog] of [[{}, live, ids.map(native)],
    [environment, undefined, ids.map(native)], [environment, { reason: "catalog_unavailable", modelIds: ids }, ids.map(native)],
    [environment, live, []]]) {
    const other = { settings: { custom: "owner-setting" } };
    const config = { enabled_providers: ["nvidia", providerID, "opencode"], providers: {
      nvidia: other, [providerID]: { settings: { baseURL: "http://127.0.0.1:4098/old" },
        models: { [flash]: { disabled: false } } },
    } };
    const status = configureAmdRadeon(config, nativeCatalog, env, catalog);
    assert.equal(status.enabled, false);
    assert.deepEqual(config.enabled_providers, ["nvidia", "opencode"]);
    assert.equal(config.providers.nvidia, other);
    assert.equal(config.providers[providerID].models[flash].disabled, true);
  }
});

test("managed AMD routing and auth cannot inherit a stale queue endpoint, key, canonical provider or request body", () => {
  const config = { providers: { [providerID]: {
    canonical: "openai", env: ["NVIDIA_API_KEY"], package: "untrusted-package",
    settings: { apiKey: "stale-secret", baseURL: "https://untrusted.invalid", provider: "different-provider" },
    headers: { Authorization: "Bearer stale-secret" }, body: { model: "paid-alias" },
    models: {
      [flash]: { package: "untrusted-package", settings: { apiKey: "stale-secret", baseURL: "http://127.0.0.1:4098/old" },
        headers: { Authorization: "Bearer stale-secret" }, body: { model: "paid-alias" }, variants: [{ id: "invalid-effort" }] },
      [`${flash}-1017`]: { disabled: false }, "unreviewed-model": { disabled: false },
    },
  } } };
  configureAmdRadeon(config, ids.map(native), environment, live);
  const provider = config.providers[providerID];
  assert.equal(provider.canonical, undefined);
  assert.equal(provider.headers, undefined);
  assert.equal(provider.body, undefined);
  assert.deepEqual(provider.settings, { baseURL, provider: providerID });
  assert.equal(provider.models[flash].settings.baseURL, undefined);
  assert.equal(provider.models[flash].headers, undefined);
  assert.equal(provider.models[flash].body, undefined);
  assert.equal(provider.models[flash].variants, undefined);
  assert.equal(provider.models[`${flash}-1017`].disabled, true);
  assert.equal(provider.models["unreviewed-model"].disabled, true);
  assert.equal(JSON.stringify(config).includes("stale-secret"), false);
});
