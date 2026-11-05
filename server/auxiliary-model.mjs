const originalFree = 'opencode/deepseek-v4.1-flash-free';
const nativeId = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const helper = { instanceId: 'opencode', model: 'nvidia/' + nativeId };

// The owner already configured and verified this NVIDIA model. Move only the
// original setup's blocked metadata defaults; preserve explicit owner choices.
export function configureAuxiliaryModel(config, settings, nativeCatalog, alreadyApplied = false) {
  if (alreadyApplied) return { ready: false, changed: false };
  const available = nativeCatalog.some(m => m.providerID === 'nvidia' && m.id === nativeId &&
    m.enabled !== false && m.status !== 'deprecated' && m.capabilities?.tools && m.limit?.output > 0);
  if (!available) return { ready: false, changed: false };
  let changed = false;
  if (config.small_model === originalFree) { config.small_model = helper.model; changed = true; }
  if (!Object.hasOwn(config.agents?.compaction || {}, 'model') &&
      !Object.hasOwn(config.agent?.compaction || {}, 'model')) {
    config.agents ??= {};
    config.agents.compaction = { ...config.agents.compaction,
      model: { providerID: 'nvidia', model: nativeId } };
    changed = true;
  }
  if (settings.textGenerationModelSelection?.instanceId === 'opencode' &&
      settings.textGenerationModelSelection.model === originalFree) {
    settings.textGenerationModelSelection = { ...helper, options: [{ id: 'agent', value: 'title' }] };
    changed = true;
  }
  return { ready: true, changed };
}
