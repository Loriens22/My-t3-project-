import https from "node:https";

// AMD Radeon Cloud / Token Factory is the China service selected by the owner,
// not global AMD Token Lab and not tokenlab.sh. Never make this credential's
// destination configurable. API contract, checked 2026-11-12:
// https://amd-aim.github.io/radeon-cloud-docs/api/models/
// https://amd-aim.github.io/radeon-cloud-docs/api/chat-completions/
// https://amd-aim.github.io/radeon-cloud-docs/api/usage/
const providerID = "amd-radeon";
const keyVariable = "AMD_RADEON_API_KEY";
const baseURL = "https://developer.amd.com.cn/radeon/api/v1";
const catalogURL = `${baseURL}/models`;
const packageName = "@opencode/ai/providers/openai-compatible";
const maxCatalogBytes = 1024 * 1024;
const catalogTimeout = 10000;
const contextCap = 65536;
const outputCap = 16384;

// Exact API IDs, not model-card titles or upstream checkpoint names. In
// particular DeepSeek-V4.1-Flash-1017 is NOT an accepted Token Factory API ID.
// These five model cards explicitly document streaming and tool calling.
const definitions = Object.freeze({
  "DeepSeek-V4.1-Flash": {
    name: "DeepSeek V4.1 Flash",
    effort: ["low", "high", "max"], toggle: true, defaultEffort: "none",
  },
  "Qwen3.8-Flash-Next": {
    name: "Qwen3.8 Flash Next",
    effort: ["low", "medium", "xhigh"], toggle: true, defaultEffort: "low",
  },
  "Qwen3.8-27B": {
    name: "Qwen3.8 27B",
    effort: ["low", "medium", "xhigh"], defaultEffort: "low",
  },
  "GLM-5.3-Flash": {
    name: "GLM 5.3 Flash",
    effort: ["low", "medium", "high"], defaultEffort: "low",
  },
  // Reasoning is always on and effort values have no effect on this host.
  "MiMo-V2.6-Flash": { name: "MiMo V2.6 Flash" },
});

function credential(environment) {
  const key = environment?.[keyVariable];
  return typeof key === "string" && key.trim() && !/[\r\n]/u.test(key)
    ? key.trim() : undefined;
}

export function amdRadeonDiscoveryProviders(environment = process.env) {
  return credential(environment) ? [providerID] : [];
}

function requestModelList(url, options) {
  return new Promise((resolve, reject) => {
    // Defense in depth: this helper never authenticates another host, follows a
    // redirect, or accepts an endpoint from a stale config/environment variable.
    if (url !== catalogURL) {
      reject(new Error("AMD Radeon model catalog unavailable"));
      return;
    }
    const agent = new https.Agent({ proxyEnv: process.env });
    let completed = false;
    let request;
    let response;
    let deadline;
    const finish = (value, error = false) => {
      if (completed) return;
      completed = true;
      clearTimeout(deadline);
      response?.destroy();
      request?.destroy();
      agent.destroy();
      // Neither upstream error bodies nor exception messages are retained:
      // proxies and authentication errors can echo a credential.
      if (error) reject(new Error("AMD Radeon model catalog unavailable"));
      else resolve(value);
    };
    deadline = setTimeout(() => finish(undefined, true), catalogTimeout);
    try {
      request = https.get(catalogURL, { agent, headers: options.headers }, incoming => {
        response = incoming;
        if (incoming.statusCode !== 200) {
          finish({ status: incoming.statusCode });
          return;
        }
        const chunks = [];
        let bytes = 0;
        incoming.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > maxCatalogBytes) {
            finish(undefined, true);
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          if (completed) return;
          try {
            finish({ status: 200, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch { finish(undefined, true); }
        });
        incoming.on("aborted", () => finish(undefined, true));
        incoming.on("error", () => finish(undefined, true));
      });
      request.on("error", () => finish(undefined, true));
    } catch { finish(undefined, true); }
  });
}

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const reviewedID = id => typeof id === "string" && Object.hasOwn(definitions, id);

function currentToolModel(model) {
  // These are documented /models fields, not guessed provider capabilities.
  // Requiring free=true also prevents a catalog's future pricing drift from
  // silently opting this installation into paid model calls.
  return model?.free === true && positiveInteger(model.context_length) &&
    Array.isArray(model.supported_parameters) &&
    ["tools", "stream", "max_tokens"].every(name => model.supported_parameters.includes(name)) &&
    Array.isArray(model.providers) && model.providers.some(backend =>
      backend?.tools === true && backend.streaming === true);
}

export async function amdRadeonCatalog(environment = process.env, fetchModels = requestModelList) {
  const key = credential(environment);
  if (!key) return { reason: "missing_key", modelIds: [] };
  try {
    const result = await fetchModels(catalogURL, {
      headers: { accept: "application/json", authorization: `Bearer ${key}` },
      redirect: "error", timeout: catalogTimeout, maxBytes: maxCatalogBytes,
    });
    if (result?.status !== 200 || !Array.isArray(result.body?.data)) {
      return { reason: "catalog_unavailable", modelIds: [] };
    }
    const rows = new Map();
    for (const model of result.body.data) {
      if (!reviewedID(model?.id)) continue;
      const entries = rows.get(model.id) ?? [];
      entries.push(model);
      rows.set(model.id, entries);
    }
    const models = [...rows].filter(([, entries]) => entries.every(currentToolModel));
    if (!models.length) return { reason: "catalog_unavailable", modelIds: [] };
    return {
      reason: "ready",
      modelIds: models.map(([id]) => id),
      contextLimits: Object.fromEntries(models.map(([id, entries]) =>
        [id, Math.min(contextCap, ...entries.map(model => model.context_length))])),
    };
  } catch {
    return { reason: "catalog_unavailable", modelIds: [] };
  }
}

// Native V2 schemas:
// https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/config/provider.ts
// Seed only the explicit discovery document. The final runtime configuration
// must intersect the authenticated current catalog with enabled native tools.
export function configureAmdRadeon(config, nativeCatalog = [], environment = process.env, catalog,
  { seedDiscovery = false } = {}) {
  const enabled = new Set((config.enabled_providers ?? ["opencode"]).filter(id => id !== providerID));
  const keyAvailable = Boolean(credential(environment));
  const publicIDs = new Set(catalog?.reason === "ready" && Array.isArray(catalog.modelIds)
    ? catalog.modelIds.filter(reviewedID) : []);
  const native = (Array.isArray(nativeCatalog) ? nativeCatalog : [])
    .filter(model => model?.providerID === providerID);
  const validNative = model => model.enabled !== false &&
    !["deprecated", "disabled", "retired"].includes(model.status) &&
    (model.type === undefined || model.type === "chat") &&
    model.capabilities?.tools === true && positiveInteger(model.limit?.context) &&
    positiveInteger(model.limit?.output);
  const allowed = new Set(keyAvailable ? [...publicIDs].filter(id => seedDiscovery === true ||
    native.some(model => model.id === id && validNative(model))) : []);
  config.providers ??= {};
  const previous = config.providers[providerID]?.models ?? {};
  const modelIDs = [...new Set([...Object.keys(previous), ...native.map(model => model.id).filter(id =>
    typeof id === "string"), ...Object.keys(definitions)])];
  config.providers[providerID] = {
    name: "AMD Radeon (Token Factory)",
    env: [keyVariable],
    package: packageName,
    settings: { baseURL, provider: providerID },
    models: Object.fromEntries(modelIDs.map(id => {
      if (!allowed.has(id)) return [id, { disabled: true }];
      const definition = definitions[id];
      const nativeModels = native.filter(model => model.id === id && validNative(model));
      const publicContext = positiveInteger(catalog.contextLimits?.[id]) ? catalog.contextLimits[id] : contextCap;
      const context = Math.min(contextCap, publicContext, ...nativeModels.map(model => model.limit.context));
      const output = Math.min(outputCap, Math.max(1, Math.floor(context / 4)),
        ...nativeModels.map(model => model.limit.output));
      return [id, {
        name: `${definition.name} (free trial)`,
        type: "chat", modelID: id, package: packageName,
        capabilities: {
          tools: true, input: ["text"], output: ["text"], temperature: true,
          reasoning: { supported: true,
            ...(definition.toggle ? { toggle: true } : {}),
            ...(definition.effort ? { effort: [...definition.effort] } : {}) },
        },
        compatibility: {
          reasoningField: "reasoning", requireReasoning: true, maxTokensField: "max_tokens",
        },
        // Native 2.2.5 openai-chat.ts already joins every initial SystemPart
        // into ONE first system message, and never emits a developer role.
        // Keep original instruction text/source metadata untouched; no prompt
        // rewriting plugin or changes to user/tool history are necessary.
        // Operator caps are intentionally below the hosted model windows.
        limit: { context, output },
        // Zero monetary charge does NOT mean unmetered: the catalog's decimal
        // prices consume daily Token Factory POINTS, not US dollars. Never map
        // those prices into OpenCode's USD-per-million-token cost fields.
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        settings: definition.defaultEffort ? { reasoningEffort: definition.defaultEffort } : {},
        disabled: false,
      }];
    })),
  };
  if (allowed.size) enabled.add(providerID);
  config.enabled_providers = [...enabled];
  return {
    provider: providerID, name: "AMD Radeon (Token Factory)", enabled: allowed.size > 0,
    modelCount: allowed.size,
    reason: !keyAvailable ? "missing_key" : allowed.size ? "ready" : "catalog_unavailable",
    keyVariable, billing: "free_trial_points",
  };
}
