import fs from 'node:fs';

// Exact OpenCode 2.2.5 stock strings/renderings are reproduced under their
// upstream MIT license in stock-prompts.json. Source:
// https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/system-prompt.ts
// GPT-OSS optimized stock:
// https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin/system-prompt/gpt.txt
// Only exact public built-in prose/documentation is compacted. Task/repository
// instructions, history, tool names/schema validation, options and permissions
// remain intact. Tool source URLs and MIT attribution are in stock-prompts.json.
const stock = JSON.parse(fs.readFileSync(new URL('./stock-prompts.json', import.meta.url), 'utf8'));
const gptModels = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
const base = "You are OpenCode's coding agent: finish the user's task. Follow harness/system-reminder instructions. Use GitHub Markdown, clear file paths and concise plain language. Parallelize independent work. Match repo conventions. Investigate unfamiliar files before replacing/deleting them. Keep credentials secret. Verify work; report failures and unverified results honestly.";
const guidance = {
  shell: 'Prefer dedicated tools; shell is a fallback. Avoid separator-banner command chains.',
  write: 'Use write for new/whole files; edit for targeted changes.',
  edit: 'Edit: oldString must match exactly and differ from newString. Ensure uniqueness with context, or set replaceAll=true.',
};
// GPT-OSS receives this separate stock template from Native OptimizePlugin.
// Preserve its extra delegation, task-steering, communication and scope rules.
const gptRules = "Give brief commentary only for meaningful findings, tradeoffs or blockers. Treat new messages as task steering unless the user clearly cancels or replaces the task. Put questions and final replies outside commentary. Final answers must stand alone and lead with outcomes. Delegate only with explicit user or applicable AGENTS.md/skill instruction. Stay within the requested scope. Preserve others' changes; destructive git operations and broad deletes need clear user authorization and scope. Ask if that scope is unclear. Prefer noninteractive git.";
const render = (prompts, extra = '') => new Map(prompts.map(({ text, tools }) => [
  text, [base, extra, ...tools.map(tool => guidance[tool])].filter(Boolean).join('\n'),
]));
const replacements = render(stock.prompts);
const gptReplacements = render(stock.gptPrompts, gptRules);


const shellDescriptions = new Map(stock.toolDescriptions.shell.variants.map(({ text, shell }) => [
  text, [
    shell ? `Run a shell command on Linux using ${shell} and return output.` : 'Run a shell command and return output.',
    'Quote paths containing spaces/special characters. Prefer dedicated tools.',
    'Large output is truncated; the complete result is saved to a file. Rely on truncation unless filtering helps.',
    'Timeout is optional. Background commands default to no timeout, return immediately and notify completion; DO NOT poll.',
  ].join(' '),
]));
const shellPropertyDescriptions = {
  workdir: 'Working directory; defaults to the current directory. Set it here rather than using cd in the command.',
  timeout: 'Timeout in milliseconds: foreground default 120000; 0 disables. Background has no timeout unless set.',
  background: "Run in background and return immediately (dev servers/long builds). No trailing '&' needed. Completion is notified automatically; DO NOT poll.",
};
const executeDescription = 'Run JavaScript in confined Code Mode to compose tool calls and HTTP requests. HTTP uses fetch; other external access uses tools. No imports, direct filesystem access, timers, setTimeout or sleep. Only tools listed in Code Mode catalog instructions or returned by search are callable; ignore other displayed tools. Use exact catalog paths/signatures, preserving bracket notation such as tools.ns["tool-name"](input); never infer or normalize names. Await every call whose completion matters; pending calls are interrupted at exit. Use Promise.allSettled for independent calls. Prefer explicit return; otherwise the final top-level expression is the result.';

function compactToolDocumentation(event) {
  const tools = event.tools;
  if (!tools) return;
  let changed;
  const shell = tools.shell;
  const shellText = shellDescriptions.get(shell?.description);
  if (shellText !== undefined && shellText.length < shell.description.length) {
    let input = shell.input;
    let properties;
    for (const [name, previous] of Object.entries(stock.toolDescriptions.shell.properties)) {
      const property = input?.properties?.[name];
      // The exact public annotation must match as well. Never shorten an
      // owner's custom annotation, and never change any validation field.
      if (property?.description !== previous) continue;
      properties ??= { ...input.properties };
      properties[name] = { ...property, description: shellPropertyDescriptions[name] };
    }
    if (properties) input = { ...input, properties };
    changed = { ...tools, shell: { ...shell, description: shellText, input } };
  }
  const execute = tools.execute;
  if (execute?.description === stock.toolDescriptions.execute.text) {
    changed ??= { ...tools };
    changed.execute = { ...execute, description: executeDescription };
  }
  if (changed) event.tools = changed;
}

function replacementFor(event) {
  if (event?.model?.providerID !== 'groq') return undefined;
  const profile = event.model.id === 'qwen/qwen3.8-27b' ? replacements :
    gptModels.has(event.model.id) ? gptReplacements : undefined;
  if (!profile) return undefined;
  const first = event.system?.[0];
  // An instruction-source part is never a candidate, even if its author used
  // exactly the same wording as the built-in prompt.
  if (!first || first.metadata?.experimental?.instructions !== undefined) return undefined;
  const text = profile.get(first.text);
  if (text === undefined || text.length >= first.text.length) return undefined;
  return text;
}

export function compactGroqContext(event) {
  const text = replacementFor(event);
  if (text === undefined) return false;
  event.system[0] = { ...event.system[0], text };
  compactToolDocumentation(event);
  return true;
}

export default {
  id: 't3.groq-context',
  async setup(context) {
    const registration = await context.session.hook('context', async event => {
      if (replacementFor(event) === undefined) return;
      // As in Native OptimizePlugin, a custom agent's system takes precedence,
      // even if its owner deliberately copied the stock text verbatim.
      let agent;
      try { agent = await context.agent.get({ agentID: event.agent }); }
      catch { return; }
      if (!agent?.data || agent.data.system) return;
      compactGroqContext(event);
    }, { providerID: 'groq' });
    return () => registration.dispose();
  },
};
