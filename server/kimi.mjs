// Use OpenCode 2's native providers: they preserve Kimi reasoning_content across
// tool calls and read credentials from their own environment bindings.
export const kimiProviders = Object.freeze([
  { id: "moonshotai", key: "MOONSHOT_API_KEY", name: "Moonshot API" },
  { id: "kimi-code-plan-global", key: "KIMI_API_KEY", name: "Kimi Code" },
]);

export function kimiDiscoveryProviders(environment = process.env) {
  return kimiProviders.filter(provider => environment[provider.key]?.trim()).map(provider => provider.id);
}

export function configureKimiProviders(config, nativeCatalog, environment = process.env) {
  const managed = new Set(kimiProviders.map(provider => provider.id));
  const enabled = new Set((config.enabled_providers || ["opencode"]).filter(id => !managed.has(id)));
  config.providers ??= {};
  const status = [];
  for (const provider of kimiProviders) {
    const hasKey = Boolean(environment[provider.key]?.trim());
    const candidates = nativeCatalog.filter(model => model.providerID === provider.id);
    const available = candidates.filter(model => model.enabled !== false &&
      model.status !== "deprecated" && model.capabilities?.tools && model.limit?.output > 0);
    const ready = hasKey && available.length > 0;
    const allowed = new Set(ready ? available.map(model => model.id) : []);
    const providerConfig = config.providers[provider.id] ??= {};
    const previous = providerConfig.models || {};
    providerConfig.models = Object.fromEntries(
      [...new Set([...Object.keys(previous), ...candidates.map(model => model.id)])].map(id => {
        const entry = { ...previous[id], disabled: !allowed.has(id) };
        if (provider.id === "kimi-code-plan-global") {
          // Both services expose native OpenAI chat format. This bundled
          // adapter keeps Kimi reasoning and low/high/max effort semantics;
          // provider identity and KIMI_API_KEY binding remain unchanged.
          entry.package = "@opencode/ai/providers/moonshot/chat";
        }
        if (/^(?:kimi-)?k3\.1-pro(?:-highspeed)?$/.test(id)) {
          // K3.1 rejects non-thinking requests. OpenCode's native adapter
          // accepts this provider setting and retains the selected effort.
          entry.settings = { ...entry.settings,
            thinking: { ...entry.settings?.thinking, type: "enabled" } };
        }
        return [id, entry];
      }),
    );
    if (ready) enabled.add(provider.id);
    status.push({ provider: provider.id, name: provider.name, enabled: ready,
      modelCount: allowed.size, reason: !hasKey ? "missing_key" : ready ? "ready" : "catalog_unavailable",
      keyVariable: provider.key });
  }
  config.enabled_providers = [...enabled];
  return status;
}
