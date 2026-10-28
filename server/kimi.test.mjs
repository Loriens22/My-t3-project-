import assert from "node:assert/strict";
import test from "node:test";
import { configureKimiProviders, kimiDiscoveryProviders } from "./kimi.mjs";
import { configureInferenceRoutes } from "./inference-routing.mjs";

const moonshot = { providerID: "moonshotai", id: "kimi-k3.1-pro", enabled: true,
  status: "active", capabilities: { tools: true }, limit: { output: 1048576 }, baseURL: "https://api.moonshot.ai/v1" };
const coding = { ...moonshot, providerID: "kimi-code-plan-global", id: "k3.1-pro", baseURL: "https://api.kimi.ai/coding/v1" };

test("Moonshot and Coding Plan keys enable separate native provider catalogs", () => {
  assert.deepEqual(kimiDiscoveryProviders({ MOONSHOT_API_KEY: "test" }), ["moonshotai"]);
  assert.deepEqual(kimiDiscoveryProviders({ KIMI_API_KEY: "test" }), ["kimi-code-plan-global"]);
  const config = { enabled_providers: ["opencode", "nvidia"] };
  const status = configureKimiProviders(config, [moonshot, coding], { MOONSHOT_API_KEY: "test" });
  assert.deepEqual(config.enabled_providers, ["opencode", "nvidia", "moonshotai"]);
  assert.equal(status[0].modelCount, 1);
  assert.equal(status[1].reason, "missing_key");
  assert.equal(config.providers.moonshotai.models[moonshot.id].settings.thinking.type, "enabled");
  assert.equal(config.providers["kimi-code-plan-global"].models["k3.1-pro"].disabled, true);
  assert.equal(config.providers["kimi-code-plan-global"].models["k3.1-pro"].package, "@opencode/ai/providers/moonshot/chat");
  assert.equal(JSON.stringify(config).includes("test"), false);
});

test("missing key or native catalog disables stale models without dropping other settings", () => {
  const config = { enabled_providers: ["opencode", "nvidia", "moonshotai"],
    providers: { moonshotai: { models: { "kimi-k3.1-pro": { settings: { reasoningEffort: "low" } } } } } };
  const status = configureKimiProviders(config, [], { MOONSHOT_API_KEY: "test" });
  assert.equal(status[0].reason, "catalog_unavailable");
  assert.equal(config.providers.moonshotai.models["kimi-k3.1-pro"].disabled, true);
  assert.equal(config.providers.moonshotai.models["kimi-k3.1-pro"].settings.reasoningEffort, "low");
  assert.deepEqual(config.enabled_providers, ["opencode", "nvidia"]);
});

test("only current tool-capable native models are offered", () => {
  const config = {};
  configureKimiProviders(config, [moonshot, { ...moonshot, id: "old", status: "deprecated" },
    { ...moonshot, id: "disabled", enabled: false }, { ...moonshot, id: "embed", capabilities: { tools: false } }], { MOONSHOT_API_KEY: "test" });
  assert.deepEqual(Object.entries(config.providers.moonshotai.models).filter(([,v]) => !v.disabled).map(([id]) => id), [moonshot.id]);
});

test("Kimi native endpoint paths share the existing queue and retain native model options", () => {
  const config = {};
  configureKimiProviders(config, [moonshot, coding], { MOONSHOT_API_KEY: "test", KIMI_API_KEY: "test" });
  config.providers.moonshotai.models[moonshot.id].settings = { reasoningEffort: "high" };
  const routes = configureInferenceRoutes(config, [moonshot, coding]);
  assert.deepEqual(Object.values(routes).sort(), [coding.baseURL, moonshot.baseURL].sort());
  assert.equal(config.providers.moonshotai.models[moonshot.id].settings.reasoningEffort, "high");
  for (const m of [moonshot, coding]) {
    assert.match(config.providers[m.providerID].models[m.id].settings.baseURL, /^http:\/\/127\.0\.0\.1:4098\/[a-f0-9]{16}$/);
  }
});

test("untrusted, credentialed, wrong-service and redirected endpoints are rejected without logging their values", () => {
  for (const baseURL of ["malformed secret endpoint", "http://api.moonshot.ai/v1", "https://evil.example/v1", "https://api.moonshot.ai.evil.example/v1",
    "https://secret@api.moonshot.ai/v1", "https://api.moonshot.ai/v1?api_key=secret", "https://api.moonshot.ai/v1#secret",
    "https://api.moonshot.ai/coding/v1", "https://api.moonshot.ai:444/v1"]) {
    const config = { providers: { moonshotai: { models: { [moonshot.id]: { disabled: false } } } } };
    assert.throws(() => configureInferenceRoutes(config, [{ ...moonshot, baseURL }]), error => !error.message.includes("secret") && /Unrecognized/.test(error.message));
  }
});

test("existing free and NVIDIA endpoint variants keep their stable queue route ids", () => {
  const catalog = [{ providerID: "opencode", id: "free", baseURL: "https://opencode.ai/inference/anthropic/v1" },
    { providerID: "nvidia", id: "openai/gpt-oss-20b", baseURL: "https://integrate.api.nvidia.com/v1" }];
  const config = { providers: Object.fromEntries(catalog.map(m => [m.providerID, { models: { [m.id]: { disabled: false } } }])) };
  assert.deepEqual(Object.values(configureInferenceRoutes(config, catalog)), catalog.map(m => m.baseURL));
});
