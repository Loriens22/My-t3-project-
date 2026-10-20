import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { browserBudget, browserProcesses } from './browser-resources.mjs';

const pressure = { currentBytes: 995, limitBytes: 1000, workingBytes: 960, stalledPercent: 5 };

test('healthy file cache leaves browser tools running; pressure releases the largest group', () => {
  const processes = [
    { pid: 101, ppid: 10, startTicks: 11, ageMs: 60000, rssBytes: 80 },
    { pid: 102, ppid: 101, startTicks: 12, ageMs: 59000, rssBytes: 100 },
    { pid: 201, ppid: 20, startTicks: 21, ageMs: 60000, rssBytes: 90 },
  ];
  const signals = [];
  const budget = browserBudget({ read: () => processes, prioritize: () => {}, minRssBytes: 1, kill: (...args) => signals.push(args) });
  assert.equal(budget.relieve({ sample: { ...pressure, workingBytes: 600 } }), false);
  assert.deepEqual(signals, []);
  assert.equal(budget.relieve({ sample: pressure }), true);
  assert.deepEqual(signals, [[101, 'SIGTERM']]);
  budget.close();
});

test('forced cleanup does not kill a reused process identity', async () => {
  let processes = [
    { pid: 101, ppid: 10, startTicks: 11, ageMs: 60000, rssBytes: 80 },
    { pid: 102, ppid: 101, startTicks: 12, ageMs: 59000, rssBytes: 100 },
  ];
  const signals = [];
  const budget = browserBudget({ read: () => processes, prioritize: () => {}, minRssBytes: 1, killDelayMs: 10, kill: (...args) => signals.push(args) });
  assert.equal(budget.relieve({ sample: pressure }), true);
  processes = [{ ...processes[1], startTicks: 999 }];
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(signals, [[101, 'SIGTERM']]);
  budget.close();
});

test('a real browser-named child exits under pressure while the caller stays alive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-browser-budget-test-'));
  const binary = path.join(dir, 'headless_shell');
  fs.copyFileSync('/bin/sleep', binary);
  const child = spawn(binary, ['60'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const budget = browserBudget({ minAgeMs: 0, minRssBytes: 0 });
  try {
    assert.ok(browserProcesses().some((p) => p.pid === child.pid));
    assert.equal(budget.relieve({ sample: pressure }), true);
    assert.equal((await exited).signal, 'SIGTERM');
    assert.ok(process.pid > 0);
  } finally {
    child.kill('SIGKILL');
    budget.close();
    fs.unlinkSync(binary); fs.rmdirSync(dir);
  }
});
