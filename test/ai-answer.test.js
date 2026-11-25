import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpuScenario, mcpCall, verifyCpuAnswer } from '../lib/ai-answer.js';

const scenario = cpuScenario(1, '-123', Date.parse('2025-01-01T00:01:00Z'));
const iso = ms => new Date(ms).toISOString();
const { stime, etime } = scenario.fixed;
const rows = Array.from({ length: 12 }, (_, i) => ({ time: stime + i * 5000, _id_: -123, cpu: i ? 12.234 : 24.126 }));
const reference = { ok: true, status: 200, body: rows };
const answer = {
  projectCode: 1, serverId: '-123', metric: 'cpu', unit: '%',
  startUtc: iso(stime), endUtc: iso(etime), sampleCount: 12, averageCpu: 13.22, maxCpu: 24.13,
};
function capture(values = rows) {
  const text = [
    `**Period**: ${iso(stime)} → ${iso(etime)}`, '', '| time | _id_ | cpu (%) |', '| --- | --- | --- |',
    ...values.map(row => `| ${row.time} | ${row._id_} | ${row.cpu.toFixed(2)} |`),
  ].join('\n');
  return { call: mcpCall(scenario), result: { content: [{ type: 'text', text }] } };
}
const check = (value, input = capture(), http = reference) =>
  verifyCpuAnswer(scenario, input, { text: JSON.stringify(value) }, http);

test('compares the submitted answer with independent raw and displayed values', async () => {
  const { mcp, ai } = await check(answer);
  assert.equal(mcp.status, 'PASS');
  assert.equal(ai.status, 'PASS');
  assert.notEqual(ai.independent.raw.averageCpu, answer.averageCpu);
  assert.equal(ai.responsibility, 'NONE');
});

for (const [name, patch] of [
  ['incorrect average', { averageCpu: 13.23 }],
  ['incorrect maximum', { maxCpu: 24.12 }],
  ['incorrect sample count', { sampleCount: 11 }],
  ['incorrect server', { serverId: '999' }],
  ['incorrect project', { projectCode: 2 }],
  ['incorrect window', { endUtc: iso(etime - 5000) }],
  ['incorrect unit', { unit: 'fraction' }],
]) {
  test(name + ' fails only the AI answer', async () => {
    const { mcp, ai } = await check({ ...answer, ...patch });
    assert.equal(mcp.status, 'PASS');
    assert.equal(ai.status, 'FAIL');
    assert.equal(ai.responsibility, 'AI');
  });
}

test('missing fields and malformed types or JSON fail the format check', async () => {
  const { maxCpu, ...missing } = answer;
  for (const submission of [{ text: JSON.stringify(missing) }, { text: 'not JSON' }, { text: JSON.stringify({ ...answer, maxCpu: '24.13' }) }]) {
    const { ai } = await verifyCpuAnswer(scenario, capture(), submission, reference);
    assert.equal(ai.status, 'FAIL');
    assert.equal(ai.reason, 'AI_ANSWER_FORMAT');
  }
});

test('incomplete reference does not establish either result', async () => {
  for (const http of [undefined, { ...reference, body: rows.slice(1) },
    { ...reference, body: [...rows.slice(1), rows[1]] }]) {
    const { mcp, ai } = await verifyCpuAnswer(scenario, capture(), { text: JSON.stringify(answer) }, http);
    assert.equal(mcp.status, 'UNVERIFIABLE');
    assert.equal(ai.status, 'UNVERIFIABLE');
  }
});

test('correct AI numbers cannot override a bad MCP response', async () => {
  const wrongRows = [{ ...rows[0], cpu: 90 }, ...rows.slice(1)];
  const { mcp, ai } = await check(answer, capture(wrongRows));
  assert.equal(mcp.status, 'FAIL');
  assert.equal(ai.status, 'PASS');
  assert.equal(ai.responsibility, 'MCP');
  const both = await check({ ...answer, maxCpu: 90 }, capture(wrongRows));
  assert.equal(both.ai.responsibility, 'MCP_AND_AI');
});

test('actual MCP invocation must match the requested scope', async () => {
  const input = capture();
  input.call.args.projectCode = 4;
  const { mcp, ai } = await check(answer, input);
  assert.equal(mcp.reason, 'MCP_CALL_MISMATCH');
  assert.equal(ai.reason, 'AI_QUERY_CONDITIONS_MISMATCH');
});

test('AI execution failure is distinct from wrong data', async () => {
  const { mcp, ai } = await verifyCpuAnswer(scenario, capture(), { failed: true }, reference);
  assert.equal(mcp.status, 'PASS');
  assert.equal(ai.status, 'AI_FAILED');
  assert.equal(ai.responsibility, 'AI_EXECUTION');
});
