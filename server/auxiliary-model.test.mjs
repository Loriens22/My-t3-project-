import assert from 'node:assert/strict';
import test from 'node:test';
import { configureAuxiliaryModel } from './auxiliary-model.mjs';
const free = 'opencode/deepseek-v4.1-flash-free';
const id = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const model = { providerID: 'nvidia', id, enabled: true, capabilities: { tools: true }, limit: { output: 32768 } };
test('metadata defaults move to an available helper while main models and permissions remain identical', () => {
  const c = { model: free, small_model: free, permission: 'allow' };
  const s = { defaultModelSelection: { instanceId: 'opencode', model: free, options: [{ id: 'variant', value: 'high' }] },
    textGenerationModelSelection: { instanceId: 'opencode', model: free }, defaultRuntimeMode: 'full-access' };
  const main = structuredClone(s.defaultModelSelection);
  assert.equal(configureAuxiliaryModel(c, s, [model]).changed, true);
  assert.equal(c.small_model, 'nvidia/' + id);
  assert.deepEqual(c.agents.compaction.model, { providerID: 'nvidia', model: id });
  assert.equal(s.textGenerationModelSelection.model, 'nvidia/' + id);
  assert.deepEqual(s.textGenerationModelSelection.options, [{ id: 'agent', value: 'title' }]);
  assert.deepEqual(s.defaultModelSelection, main);
  assert.equal(c.model, free);
  assert.equal(c.permission, 'allow'); assert.equal(s.defaultRuntimeMode, 'full-access');
});
test('explicit native/legacy compaction and title choices are preserved', () => {
  for (const key of ['agents', 'agent']) {
    const c = { small_model: 'owner/helper', [key]: { compaction: { model: 'owner/summary', system: 'owner rules' } } };
    const s = { textGenerationModelSelection: { instanceId: 'opencode', model: 'owner/title' } };
    const expected = structuredClone({ c, s }); configureAuxiliaryModel(c, s, [model]);
    assert.deepEqual({ c, s }, expected);
  }
});
test('missing/disabled helper and an already applied migration leave all settings untouched', () => {
  for (const [models, applied] of [[[], false], [[{ ...model, enabled: false }], false], [[model], true]]) {
    const c = { small_model: free }; const s = { textGenerationModelSelection: { instanceId: 'opencode', model: free } };
    const expected = structuredClone({ c, s });
    assert.equal(configureAuxiliaryModel(c, s, models, applied).ready, false);
    assert.deepEqual({ c, s }, expected);
  }
});
