import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import plugin, { compactGroqContext } from './plugins/groq-context/server.mjs';

const { prompts, gptPrompts, toolDescriptions } = JSON.parse(fs.readFileSync(new URL('./plugins/groq-context/stock-prompts.json', import.meta.url), 'utf8'));
const models = ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'];
const fixture = (text, model = 'qwen/qwen3.8-27b', providerID = 'groq') => ({
  sessionID: 'owned-test', agent: 'build', model: { providerID, id: model },
  system: [{ type: 'text', text, metadata: { cache: { ttl: '1h' } } },
    { type: 'text', text: 'T3 AND REPO INSTRUCTIONS MUST SURVIVE EXACTLY\nUse the existing project.',
      metadata: { experimental: { instructions: [{ key: 'repo', text: 'REPOSITORY RULES' }] } } },
    { type: 'text', text: 'Extra owner rules: do not overwrite my draft.' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Create a city. Do not delegate.' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'owned-call', toolName: 'shell', input: { command: 'pwd' } }] }],
  tools: { shell: { description: 'Original shell tool', input: { type: 'object', properties: { command: { type: 'string' } } } },
    edit: { description: 'Original edit tool', input: { type: 'object' } } },
  options: { maxTokens: 4096, temperature: 0.6, untouched: { nested: true } },
});

test('all eight base stock renderings are reduced only for curated Groq Qwen', () => {
  assert.equal(prompts.length, 8);
  assert.equal(new Set(prompts.map(p => p.text)).size, 8);
  for (const { text, tools } of prompts) {
    const event = fixture(text);
    assert.equal(compactGroqContext(event), true);
    assert.ok(event.system[0].text.length < text.length);
    assert.ok(event.system[0].text.includes('Follow harness/system-reminder instructions'));
    assert.ok(event.system[0].text.includes('Investigate unfamiliar files'));
    assert.ok(event.system[0].text.includes('Keep credentials secret'));
    assert.ok(event.system[0].text.includes('Verify work; report failures and unverified results honestly'));
    if (tools.includes('edit')) assert.match(event.system[0].text, /oldString.*newString.*\n?[^]*replaceAll=true/);
  }
});

test('all other system content, metadata, messages, tools and options retain bytes and identity', () => {
  const event = fixture(prompts.at(-1).text);
  const previous = { systemArray: event.system, otherParts: event.system.slice(1), firstMetadata: event.system[0].metadata,
    messages: event.messages, tools: event.tools, options: event.options };
  const untouched = JSON.stringify({ system: event.system.slice(1), firstMetadata: event.system[0].metadata,
    messages: event.messages, tools: event.tools, options: event.options });
  assert.equal(compactGroqContext(event), true);
  assert.equal(event.system, previous.systemArray);
  assert.equal(event.system[0].metadata, previous.firstMetadata);
  assert.equal(event.messages, previous.messages);
  assert.equal(event.tools, previous.tools);
  assert.equal(event.options, previous.options);
  event.system.slice(1).forEach((part, i) => assert.equal(part, previous.otherParts[i]));
  assert.equal(JSON.stringify({ system: event.system.slice(1), firstMetadata: event.system[0].metadata,
    messages: event.messages, tools: event.tools, options: event.options }), untouched);
});

test('custom prompts, including a stock-prefix plus owner instructions, are completely unchanged', () => {
  for (const text of ['Custom build agent. Preserve my requirements.',
    prompts.at(-1).text + '\nOWNER EXTRA INSTRUCTION', prompts.at(-1).text.trimEnd(),
    prompts.at(-1).text.replace('GitHub-flavored', 'owner-defined')]) {
    const event = fixture(text);
    const before = JSON.stringify(event);
    assert.equal(compactGroqContext(event), false);
    assert.equal(JSON.stringify(event), before);
  }
  const event = fixture(prompts.at(-1).text);
  event.system[0].metadata = { experimental: { instructions: [{ key: 'owner', text: event.system[0].text }] } };
  const before = JSON.stringify(event);
  assert.equal(compactGroqContext(event), false);
  assert.equal(JSON.stringify(event), before);
});

test('non-Groq, non-curated models and already compacted requests remain unchanged', () => {
  for (const [provider, model] of [['nvidia', models[0]], ['openrouter', models[0]], ['groq', 'owner/custom-model']]) {
    const event = fixture(prompts.at(-1).text, model, provider);
    const before = JSON.stringify(event);
    assert.equal(compactGroqContext(event), false);
    assert.equal(JSON.stringify(event), before);
  }
  const event = fixture(prompts.at(-1).text);
  assert.equal(compactGroqContext(event), true);
  const after = JSON.stringify(event);
  assert.equal(compactGroqContext(event), false);
  assert.equal(JSON.stringify(event), after);
});

test('plugin registers only the native Groq context hook and disposes its registration', async () => {
  let seen;
  let disposed = 0;
  const cleanup = await plugin.setup({ agent: { async get(input) {
    assert.deepEqual(input, { agentID: 'build' });
    return { data: { id: 'build' } };
  } }, session: { async hook(...args) {
    seen = args;
    return { dispose() { disposed++; } };
  } } });
  assert.equal(seen[0], 'context');
  assert.equal(typeof seen[1], 'function');
  const event = fixture(prompts.at(-1).text);
  assert.equal(await seen[1](event), undefined);
  assert.ok(event.system[0].text.length < prompts.at(-1).text.length);
  assert.deepEqual(seen[2], { providerID: 'groq' });
  assert.equal(typeof cleanup, 'function');
  await cleanup();
  assert.equal(disposed, 1);
});


test('all optimized GPT stock renderings are reduced for both curated Groq GPT-OSS models', () => {
  assert.equal(gptPrompts.length, 8);
  assert.equal(new Set(gptPrompts.map(p => p.text)).size, 8);
  for (const model of models.slice(1)) for (const { text, tools } of gptPrompts) {
    const event = fixture(text, model);
    const untouched = JSON.stringify({ system: event.system.slice(1), metadata: event.system[0].metadata,
      messages: event.messages, tools: event.tools, options: event.options });
    assert.equal(compactGroqContext(event), true);
    assert.ok(event.system[0].text.length < text.length);
    assert.ok(event.system[0].text.includes('Delegate only with explicit user or applicable AGENTS.md/skill instruction'));
    assert.ok(event.system[0].text.includes('Stay within the requested scope'));
    assert.ok(event.system[0].text.includes('destructive git operations and broad deletes need clear user authorization and scope'));
    assert.ok(event.system[0].text.includes('Treat new messages as task steering'));
    assert.ok(event.system[0].text.includes('Final answers must stand alone and lead with outcomes'));
    if (tools.includes('edit')) assert.match(event.system[0].text, /oldString.*newString.*[^]*replaceAll=true/);
    assert.equal(JSON.stringify({ system: event.system.slice(1), metadata: event.system[0].metadata,
      messages: event.messages, tools: event.tools, options: event.options }), untouched);
    const after = JSON.stringify(event);
    assert.equal(compactGroqContext(event), false);
    assert.equal(JSON.stringify(event), after);
  }
});

test('GPT custom prompts, instruction sources and provider/model mismatches are unchanged', () => {
  const gpt = gptPrompts.at(-1).text;
  for (const model of models.slice(1)) {
    for (const text of ['Owner GPT agent: keep my requirements.', gpt + '\nOWNER RULES',
      gpt.trimEnd(), gpt.replace('GitHub-flavored', 'owner-defined'), prompts.at(-1).text]) {
      const event = fixture(text, model);
      const before = JSON.stringify(event);
      assert.equal(compactGroqContext(event), false);
      assert.equal(JSON.stringify(event), before);
    }
    const instruction = fixture(gpt, model);
    instruction.system[0].metadata = { experimental: { instructions: [{ key: 'repo', text: gpt }] } };
    const before = JSON.stringify(instruction);
    assert.equal(compactGroqContext(instruction), false);
    assert.equal(JSON.stringify(instruction), before);
  }
  for (const [provider, model] of [['nvidia', models[1]], ['openrouter', models[2]], ['groq', models[0]]]) {
    const event = fixture(gpt, model, provider);
    const before = JSON.stringify(event);
    assert.equal(compactGroqContext(event), false);
    assert.equal(JSON.stringify(event), before);
  }
});


test('native custom-agent configuration wins even when its system exactly copies stock text', async () => {
  for (const model of models) for (const lookup of ['custom', 'failed', 'missing']) {
    let callback;
    const original = model === models[0] ? prompts.at(-1).text : gptPrompts.at(-1).text;
    const event = fixture(original, model);
    event.tools = nativeTools();
    const before = JSON.stringify(event);
    await plugin.setup({ agent: { async get() {
      if (lookup === 'failed') throw new Error('agent configuration unavailable');
      return lookup === 'custom' ? { data: { id: 'build', system: original } } : {};
    } }, session: { async hook(name, fn) {
      callback = fn;
      return { dispose() {} };
    } } });
    assert.equal(await callback(event), undefined);
    assert.equal(JSON.stringify(event), before);
  }
});


function nativeTools(shellVariant = 1) {
  return {
    shell: {
      description: toolDescriptions.shell.variants[shellVariant].text,
      input: {
        $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
        properties: {
          command: { type: 'string', minLength: 1, description: 'Shell command string to execute' },
          workdir: { type: 'string', description: toolDescriptions.shell.properties.workdir },
          timeout: { type: 'integer', minimum: 0, maximum: 1200000,
            description: toolDescriptions.shell.properties.timeout },
          background: { type: 'boolean', description: toolDescriptions.shell.properties.background },
        },
        required: ['command'], additionalProperties: false,
      },
      permissionMarker: { untouched: true },
    },
    execute: {
      description: toolDescriptions.execute.text,
      input: { type: 'object', properties: { code: { type: 'string', minLength: 1, maxLength: 100000 } },
        required: ['code'], additionalProperties: false },
    },
    mcp_sample: { description: toolDescriptions.execute.text,
      input: { type: 'object', properties: { ownerField: { type: 'string', description: 'OWNER DOCUMENTATION' } } } },
  };
}

function freezeTree(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

function withoutChangedDocumentation(tools) {
  const result = JSON.parse(JSON.stringify(tools));
  delete result.shell.description;
  delete result.execute.description;
  for (const name of ['workdir', 'timeout', 'background']) delete result.shell.input.properties[name].description;
  return result;
}

test('known native shell/execute documentation is smaller without changing names or schema validation', () => {
  for (let variant = 0; variant < toolDescriptions.shell.variants.length; variant++) {
    const event = fixture(prompts.at(-1).text);
    const original = freezeTree(nativeTools(variant));
    event.tools = original;
    const before = JSON.stringify(original);
    const validation = withoutChangedDocumentation(original);
    assert.equal(compactGroqContext(event), true);
    assert.notEqual(event.tools, original);
    assert.notEqual(event.tools.shell, original.shell);
    assert.notEqual(event.tools.shell.input, original.shell.input);
    assert.notEqual(event.tools.execute, original.execute);
    assert.deepEqual(Object.keys(event.tools), Object.keys(original));
    assert.deepEqual(withoutChangedDocumentation(event.tools), validation);
    assert.equal(JSON.stringify(original), before, 'Shared original registry/schema was not mutated');
    assert.equal(event.tools.shell.input.properties.command, original.shell.input.properties.command);
    assert.equal(event.tools.shell.permissionMarker, original.shell.permissionMarker);
    assert.equal(event.tools.execute.input, original.execute.input);
    assert.equal(event.tools.mcp_sample, original.mcp_sample);
    assert.ok(event.tools.shell.description.length < original.shell.description.length);
    assert.ok(event.tools.execute.description.length < original.execute.description.length);
    if (toolDescriptions.shell.variants[variant].shell) {
      assert.match(event.tools.shell.description, new RegExp('Linux using ' + toolDescriptions.shell.variants[variant].shell));
    }
    for (const text of ['Quote paths', 'complete result is saved to a file', 'DO NOT poll', 'default to no timeout']) {
      assert.ok(event.tools.shell.description.includes(text));
    }
    assert.match(event.tools.shell.input.properties.timeout.description, /milliseconds.*120000.*0 disables/);
    assert.match(event.tools.shell.input.properties.timeout.description, /Background has no timeout unless set/);
    assert.match(event.tools.shell.input.properties.background.description, /No trailing '&' needed.*DO NOT poll/);
    for (const text of ['confined Code Mode', 'HTTP uses fetch', 'other external access uses tools',
      'No imports, direct filesystem access, timers, setTimeout or sleep',
      'Only tools listed in Code Mode catalog instructions or returned by search',
      'ignore other displayed tools', 'exact catalog paths/signatures', 'bracket notation',
      'never infer or normalize names', 'Await every call whose completion matters',
      'pending calls are interrupted', 'Promise.allSettled', 'explicit return', 'final top-level expression']) {
      assert.ok(event.tools.execute.description.includes(text));
    }
    const after = JSON.stringify(event);
    assert.equal(compactGroqContext(event), false);
    assert.equal(JSON.stringify(event), after);
  }
});

test('custom same-name tools, unknown native variants and custom property annotations are not rewritten', () => {
  const event = fixture(prompts.at(-1).text);
  const original = nativeTools();
  original.shell.description += '\nOwner-specific shell restrictions.';
  original.execute.description = 'Owner execute tool with different runtime semantics.';
  event.tools = freezeTree(original);
  const before = JSON.stringify(original);
  assert.equal(compactGroqContext(event), true);
  assert.equal(event.tools, original);
  assert.equal(JSON.stringify(event.tools), before);

  const propertyEvent = fixture(prompts.at(-1).text);
  const propertyTools = nativeTools();
  propertyTools.shell.input.properties.workdir.description = 'Owner working directory instruction.';
  propertyEvent.tools = freezeTree(propertyTools);
  assert.equal(compactGroqContext(propertyEvent), true);
  assert.equal(propertyEvent.tools.shell.input.properties.workdir, propertyTools.shell.input.properties.workdir);
  assert.equal(propertyEvent.tools.shell.input.properties.workdir.description, 'Owner working directory instruction.');

  for (const [provider, model] of [['nvidia', models[0]], ['groq', 'owner/custom-model']]) {
    const other = fixture(prompts.at(-1).text, model, provider);
    other.tools = freezeTree(nativeTools());
    const bytes = JSON.stringify(other);
    assert.equal(compactGroqContext(other), false);
    assert.equal(JSON.stringify(other), bytes);
  }
});

test('additional pinned stock documentation retains every tool and validation field', () => {
  const entries = toolDescriptions.additionalStock;
  const original = freezeTree(Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, {
    description: entry.text, input: { type: 'object', properties: {
      ownerField: { type: 'string', minLength: 2, description: 'Owner field documentation' },
    }, required: ['ownerField'], additionalProperties: false }, permissionMarker: { retained: true },
  }])));
  const before = JSON.stringify(original);
  const event = fixture(prompts.at(-1).text);
  event.tools = original;
  assert.equal(compactGroqContext(event), true);
  assert.deepEqual(Object.keys(event.tools), Object.keys(original));
  let saved = 0;
  for (const [name, entry] of Object.entries(entries)) {
    assert.notEqual(event.tools[name], original[name]);
    assert.equal(event.tools[name].input, original[name].input);
    assert.equal(event.tools[name].permissionMarker, original[name].permissionMarker);
    const { description, ...validation } = event.tools[name];
    const { description: old, ...unchanged } = original[name];
    assert.deepEqual(validation, unchanged);
    assert.ok(description.length < old.length);
    assert.match(entry.source, /\/v2\.2\.5\/packages\/core\/src\/tool\/plugin\//);
    saved += old.length - description.length;
  }
  assert.ok(saved > 1000);
  assert.equal(JSON.stringify(original), before);
  const expected = {
    edit: ['oldString and newString must differ', 'Preserve indentation', 'line-number prefixes', '\\n',
      'CRLF/LF', '\\r', 'exact bytes', 'typographic quote/dash/space', 'trailing line whitespace',
      'no match fails', 'match once', 'context for uniqueness', 'replaceAll=true', 'every occurrence'],
    read: ['images and PDFs', 'directly to the model', '1-based', '<line>: <content>', 'not file content',
      'Directory entries', 'offset/limit', 'larger reads', 'grep'],
    question: ['preferences', 'requirements', 'clarification', 'implementation decisions', 'direction',
      'automatically', 'do not add a free-form option', 'multiple:true', 'recommended option first', '(Recommended)'],
    grep: ['ripgrep regex', 'literal text', 'path/include', 'file paths', 'line numbers', 'previews'],
    write: ['Create or overwrite', 'missing parent directories', 'partial changes, use edit'],
    webfetch: ['HTTP/HTTPS', 'text, markdown (default), or HTML', 'more targeted tool', 'Read-only',
      'preview', 'complete output is retained in managed storage'],
  };
  for (const [name, facts] of Object.entries(expected)) for (const fact of facts) {
    assert.ok(event.tools[name].description.includes(fact), name + ': ' + fact);
  }
});

test('additional documentation leaves custom tools, other providers and custom agents unchanged', async () => {
  const tools = Object.fromEntries(Object.entries(toolDescriptions.additionalStock).map(([name, entry]) =>
    [name, { description: entry.text + '\nOWNER RULE', input: { type: 'object' } }]));
  tools.ownerTool = { description: toolDescriptions.additionalStock.edit.text, input: { type: 'object' } };
  const event = fixture(prompts.at(-1).text);event.tools = freezeTree(tools);
  assert.equal(compactGroqContext(event), true);
  assert.equal(event.tools, tools);
  for (const [provider, text] of [['nvidia', prompts.at(-1).text], ['groq', 'Owner system instructions']]) {
    const other = fixture(text, models[0], provider);
    other.tools = freezeTree(Object.fromEntries(Object.entries(toolDescriptions.additionalStock).map(([name, entry]) =>
      [name, { description: entry.text, input: { type: 'object' } }])));
    const before = JSON.stringify(other);
    assert.equal(compactGroqContext(other), false);
    assert.equal(JSON.stringify(other), before);
  }
});
