import assert from "node:assert/strict";
import test from "node:test";
import { configureModelScope, modelScopeCatalog, modelscopeDiscoveryProviders } from "./modelscope.mjs";

const flash = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const qwen = "Qwen/Qwen3.8-27B";
const environment = { MODELSCOPE_API_KEY: " private-owner-key " };
const live = { reason: "ready", modelIds: [flash, qwen] };
const model = id => ({ providerID: "modelscope", id, enabled: true, status: "active",
  capabilities: { tools: true }, limit: { output: 32768 } });

test("public catalog discovery never sends the key or preserves unrelated paid selectors", async () => {
  let calls = 0;
  const catalog = await modelScopeCatalog(environment, async (...args) => {
    calls++;
    assert.equal(args.length, 0);
    return { status: 200, body: { data: [{ id: flash }, { id: flash }, { id: qwen },
      { id: `${flash}:DashScope` }, { id: "unreviewed/model" }, null] } };
  });
  assert.equal(calls, 1);
  assert.deepEqual(catalog, live);
  assert.equal(JSON.stringify(catalog).includes("private-owner-key"), false);
});

test("no key skips discovery, and redirects/errors/empty catalogs fail closed", async () => {
  assert.deepEqual(modelscopeDiscoveryProviders({}), []);
  assert.deepEqual(modelscopeDiscoveryProviders(environment), ["modelscope"]);
  let calls = 0;
  assert.deepEqual(await modelScopeCatalog({}, () => calls++), { reason: "missing_key", modelIds: [] });
  assert.equal(calls, 0);
  for (const response of [{ status: 302 }, { status: 401 }, { status: 500 },
    { status: 200, body: {} }, { status: 200, body: { data: [{ id: "not/reviewed" }] } }]) {
    assert.deepEqual(await modelScopeCatalog(environment, async () => response),
      { reason: "catalog_unavailable", modelIds: [] });
  }
  assert.deepEqual(await modelScopeCatalog(environment, async () => { throw new Error("private-owner-key"); }),
    { reason: "catalog_unavailable", modelIds: [] });
});

test("discovery seeds documented V2 definitions before native model.list without embedding secrets", () => {
  const config = { enabled_providers: ["opencode", "nvidia"] };
  const status = configureModelScope(config, [], environment, live);
  assert.equal(status.modelCount, 2);
  assert.deepEqual(config.enabled_providers, ["opencode", "nvidia", "modelscope"]);
  assert.equal(config.providers.modelscope.settings.baseURL, "https://api-inference.modelscope.cn/v1");
  assert.deepEqual(config.providers.modelscope.env, ["MODELSCOPE_API_KEY"]);
  assert.equal(config.providers.modelscope.models[flash].modelID, flash);
  assert.equal(config.providers.modelscope.models[flash].package, "@opencode/ai/providers/openai-compatible");
  assert.equal(config.providers.modelscope.models[flash].compatibility.requireReasoning, true);
  assert.equal(config.providers.modelscope.models[flash].compatibility.reasoningField, "reasoning_content");
  assert.equal(config.providers.modelscope.models[flash].compatibility.maxTokensField, "max_tokens");
  assert.equal(JSON.stringify(config).includes("private-owner-key"), false);
});

test("final configuration requires the seeded native catalog's enabled tool-capable metadata", () => {
  const config = {};
  const status = configureModelScope(config, [model(flash), { ...model(qwen), capabilities: { tools: false } }], environment, live);
  assert.equal(status.modelCount, 1);
  assert.equal(config.providers.modelscope.models[qwen].disabled, true);
  assert.equal(config.providers.modelscope.models[flash].disabled, false);
  const missing = {};
  assert.equal(configureModelScope(missing, [{ providerID: "opencode", id: "free" }], environment, live).enabled, false);
  for (const override of [{ enabled: false }, { status: "deprecated" }, { limit: { output: 0 } }]) {
    assert.equal(configureModelScope({}, [{ ...model(flash), ...override }], environment, live).enabled, false);
  }
});

test("no key or current public catalog disables stale ModelScope models while retaining other providers", () => {
  for (const [env, catalog] of [[{}, live], [environment, undefined],
    [environment, { reason: "catalog_unavailable", modelIds: [flash] }]]) {
    const config = { enabled_providers: ["opencode", "nvidia", "modelscope"],
      providers: { nvidia: { unchanged: true }, modelscope: { models: { [flash]: { settings: { custom: "retained" } } } } } };
    const status = configureModelScope(config, [model(flash)], env, catalog);
    assert.equal(status.enabled, false);
    assert.deepEqual(config.enabled_providers, ["opencode", "nvidia"]);
    assert.equal(config.providers.nvidia.unchanged, true);
    assert.equal(config.providers.modelscope.models[flash].disabled, true);
    assert.equal(config.providers.modelscope.models[flash].settings.custom, "retained");
  }
});

test("legacy and externally routed selectors stay disabled and stale queue endpoints are removed", () => {
  const old = "Qwen/Qwen3-Coder-30B-A3B-Instruct";
  const paid = `${flash}:DashScope`;
  const config = { providers: { modelscope: { models: { [old]: {}, [paid]: {},
    [flash]: { settings: { baseURL: "http://127.0.0.1:4098/previous-route", custom: "retained" } } } } } };
  const status = configureModelScope(config, [model(flash), model(old), model(paid)], environment, live);
  assert.equal(status.modelCount, 1);
  assert.equal(config.providers.modelscope.models[old].disabled, true);
  assert.equal(config.providers.modelscope.models[paid].disabled, true);
  assert.equal(config.providers.modelscope.models[flash].settings.baseURL, undefined);
  assert.equal(config.providers.modelscope.models[flash].settings.custom, "retained");
});
