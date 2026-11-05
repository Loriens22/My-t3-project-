import assert from "node:assert/strict";
import test from "node:test";
import { recurringFreeDiscoveryProviders, configureRecurringFreeProviders, openRouterFreeCatalog } from "./free-providers.mjs";

const groq = { providerID: "groq", id: "qwen/qwen3.8-27b", enabled: true, status: "active",
  capabilities: { tools: true }, limit: { output: 16384 }, cost: [{ input: 0.8, output: 4 }] };
const router = { ...groq, providerID: "openrouter", id: "cohere/north-mini-code:free" };
const free = { id: router.id, pricing: { prompt: "0", completion: "0", request: "0", image: "0",
  web_search: "0", internal_reasoning: "0", input_cache_read: "0", input_cache_write: "0" }, supported_parameters: ["tools"] };
const environment = { GROQ_API_KEY: "groq-test-secret", OPENROUTER_API_KEY: "router-test-secret" };

test("key discovery enables independent native providers without exposing credentials", () => {
  assert.deepEqual(recurringFreeDiscoveryProviders({}), []);
  assert.deepEqual(recurringFreeDiscoveryProviders({ GROQ_API_KEY: " " }), []);
  assert.deepEqual(recurringFreeDiscoveryProviders({ GROQ_API_KEY: "present" }), ["groq"]);
  assert.deepEqual(recurringFreeDiscoveryProviders(environment), ["groq", "openrouter"]);
  const config = { enabled_providers: ["opencode", "nvidia", "moonshotai"] };
  const status = configureRecurringFreeProviders(config, [groq, router], environment, { reason: "ready", modelIds: [router.id] });
  assert.deepEqual(config.enabled_providers, ["opencode", "nvidia", "moonshotai", "groq", "openrouter"]);
  assert.deepEqual(status.map(value => [value.enabled, value.modelCount]), [[true, 1], [true, 1]]);
  const serialized = JSON.stringify({ config, status });
  assert.equal(serialized.includes(environment.GROQ_API_KEY), false);
  assert.equal(serialized.includes(environment.OPENROUTER_API_KEY), false);
  assert.deepEqual(groq.cost, [{ input: 0.8, output: 4 }]);
});

test("Groq exposes only native, current, tool-capable models listed for the Free Plan", () => {
  const catalog = [groq,
    { ...groq, id: "openai/gpt-oss-20b" }, { ...groq, id: "openai/gpt-oss-120b" },
    { ...groq, id: "other-paid-model" }, { ...groq, id: "qwen/qwen3.8-27b", status: "deprecated" },
    { ...groq, id: "openai/gpt-oss-20b", enabled: false },
    { ...groq, id: "invalid\nmodel" }];
  const config = {};
  configureRecurringFreeProviders(config, catalog, { GROQ_API_KEY: "present" });
  assert.deepEqual(Object.entries(config.providers.groq.models).filter(([, model]) => !model.disabled).map(([id]) => id),
    ["qwen/qwen3.8-27b", "openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
  assert.equal(config.providers.groq.models["other-paid-model"].disabled, true);
  assert.equal(Object.hasOwn(config.providers.groq.models, "invalid\nmodel"), false);
  for (const changed of [{ enabled: false }, { status: "deprecated" }, { capabilities: { tools: false } },
    { limit: { output: 0 } }, { limit: { output: Infinity } }]) {
    const empty = {};
    const status = configureRecurringFreeProviders(empty, [{ ...groq, ...changed }], { GROQ_API_KEY: "present" });
    assert.equal(status[0].enabled, false);
  }
});

test("missing keys and unavailable catalogs disable stale providers while retaining custom settings", () => {
  const config = { enabled_providers: ["opencode", "groq", "openrouter"], providers: {
    groq: { settings: { custom: "retain" }, models: { [groq.id]: { settings: { reasoningEffort: "low" }, name: "My Qwen" } } },
    openrouter: { models: { "gone/model:free": { settings: { custom: true } } } },
  } };
  const status = configureRecurringFreeProviders(config, [groq, router], {});
  assert.deepEqual(config.enabled_providers, ["opencode"]);
  assert.deepEqual(status.map(value => value.reason), ["missing_key", "missing_key"]);
  assert.equal(config.providers.groq.models[groq.id].disabled, true);
  assert.equal(config.providers.groq.models[groq.id].settings.reasoningEffort, "low");
  assert.equal(config.providers.groq.models[groq.id].name, "My Qwen");
  assert.equal(config.providers.groq.settings.custom, "retain");
  assert.equal(config.providers.openrouter.models["gone/model:free"].settings.custom, true);
  assert.equal(config.providers.openrouter.models["gone/model:free"].disabled, true);
  const unavailable = {};
  const failed = configureRecurringFreeProviders(unavailable, [groq, router], environment, { reason: "catalog_unavailable", modelIds: [] });
  assert.equal(failed[0].enabled, true);
  assert.equal(failed[1].enabled, false);
});

test("OpenRouter catalog permits only explicitly free, current tool models with every price dimension zero", async () => {
  const models = [free,
    { ...free, id: "provider/paid", pricing: { prompt: "0", completion: "0" } },
    { ...free, id: "openrouter/free" },
    { ...free, id: "provider/prompt:free", pricing: { ...free.pricing, prompt: "0.001" } },
    { ...free, id: "provider/output:free", pricing: { ...free.pricing, completion: "0.001" } },
    ...["request", "image", "web_search", "internal_reasoning", "input_cache_read", "input_cache_write", "new_price_dimension"]
      .map(field => ({ ...free, id: `provider/${field}:free`, pricing: { ...free.pricing, [field]: "0.001" } })),
    { ...free, id: "provider/no-prices:free", pricing: {} },
    { ...free, id: "provider/empty:free", pricing: { prompt: "", completion: "0" } },
    { ...free, id: "provider/null:free", pricing: { prompt: null, completion: "0" } },
    { ...free, id: "provider/nonfinite:free", pricing: { prompt: "NaN", completion: "0" } },
    { ...free, id: "provider/underflow:free", pricing: { prompt: "1e-9999", completion: "0" } },
    { ...free, id: "provider/hex:free", pricing: { prompt: "0x0", completion: "0" } },
    { ...free, id: "provider/no-tools:free", supported_parameters: [] },
    { ...free, id: "provider/bad\nid:free" },
    { ...free, id: "https://invalid.example/model:free" },
    { ...free, id: "provider/../paid:free" },
    { ...free, id: "provider//empty:free" },
    { ...free, id: "provider/valid-zero:free", pricing: { prompt: "0.000", completion: 0, request: "0e-10" } },
    free,
  ];
  const catalog = await openRouterFreeCatalog(environment, async () => ({ status: 200, body: { data: models } }));
  assert.deepEqual(catalog, { reason: "ready", modelIds: [router.id, "provider/valid-zero:free"] });
});

test("OpenRouter paid drift and native capability drift remove existing free selections", async () => {
  const config = { enabled_providers: ["opencode", "openrouter"], providers: { openrouter: {
    models: { [router.id]: { settings: { reasoningEffort: "high" } } },
  } } };
  const changed = await openRouterFreeCatalog(environment, async () => ({ status: 200, body: { data: [
    { ...free, pricing: { prompt: "0", completion: "0", request: "0.01" } },
  ] } }));
  const status = configureRecurringFreeProviders(config, [router, { ...router, id: "provider/paid-twin" }], environment, changed);
  assert.equal(status[1].enabled, false);
  assert.equal(config.providers.openrouter.models[router.id].disabled, true);
  assert.equal(config.providers.openrouter.models[router.id].settings.reasoningEffort, "high");
  assert.equal(config.providers.openrouter.models["provider/paid-twin"].disabled, true);
  assert.equal(config.enabled_providers.includes("openrouter"), false);
  const unsupported = {};
  configureRecurringFreeProviders(unsupported, [{ ...router, capabilities: { tools: false } }], environment,
    { reason: "ready", modelIds: [router.id, "provider/not-in-native:free"] });
  assert.equal(unsupported.providers.openrouter.models[router.id].disabled, true);
  assert.equal(Object.hasOwn(unsupported.providers.openrouter.models, "provider/not-in-native:free"), false);
});

test("public catalog lookup sends no credential and fails closed for errors, redirects and malformed responses", async () => {
  let calls = 0;
  assert.deepEqual(await openRouterFreeCatalog({}, async () => { calls++; }), { reason: "missing_key", modelIds: [] });
  assert.equal(calls, 0);
  const good = await openRouterFreeCatalog(environment, async (...args) => {
    assert.deepEqual(args, []);
    return { status: 200, body: { data: [free] } };
  });
  assert.deepEqual(good.modelIds, [router.id]);
  for (const status of [301, 302, 401, 403, 429, 500]) {
    assert.deepEqual(await openRouterFreeCatalog(environment, async () => ({ status, body: { data: [free] } })),
      { reason: "catalog_unavailable", modelIds: [] });
  }
  for (const result of [undefined, { status: 200 }, { status: 200, body: { data: {} } }]) {
    assert.deepEqual(await openRouterFreeCatalog(environment, async () => result), { reason: "catalog_unavailable", modelIds: [] });
  }
  const failure = await openRouterFreeCatalog(environment, async () => { throw new Error(environment.OPENROUTER_API_KEY); });
  assert.deepEqual(failure, { reason: "catalog_unavailable", modelIds: [] });
  assert.equal(JSON.stringify(failure).includes(environment.OPENROUTER_API_KEY), false);
});
