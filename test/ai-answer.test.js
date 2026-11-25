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

test('relative CPU uses the captured Period and unaligned 5-second grid', async () => {
  const relative = cpuScenario(1, '-123');
  const input = capture();
  input.call = mcpCall(relative);
  assert.equal(input.call.args.timeRange, '1m');
  const relativeEnd = etime - 375;
  const relativeStart = stime - 375;
  input.result.content[0].text = input.result.content[0].text
    .replace(iso(stime), iso(relativeStart)).replace(iso(etime), iso(relativeEnd));
  input.callTiming = { startedAt: relativeEnd, finishedAt: etime + 200 };
  const submission = { text: JSON.stringify({ ...answer, startUtc: iso(relativeStart), endUtc: iso(relativeEnd) }) };
  const { mcp, ai } = await verifyCpuAnswer(relative, input, submission, reference);
  assert.equal(mcp.status, 'PASS');
  assert.equal(ai.status, 'PASS');
  input.callTiming.startedAt += 1;
  const stale = await verifyCpuAnswer(relative, input, submission, reference);
  assert.equal(stale.mcp.reason, 'MCP_PERIOD_OUTSIDE_CALL');
  assert.equal(stale.ai.status, 'UNVERIFIABLE');
});

test('only a matching interior with exchanged edge rows establishes a precision limit', async () => {
  const relative = cpuScenario(1, '-123');
  const input = capture([...rows.slice(1), { ...rows[0], time: etime }]);
  input.call = mcpCall(relative);
  input.callTiming = { startedAt: etime + 79, finishedAt: etime + 205 };
  input.result.content[0].text = input.result.content[0].text
    .replace(iso(stime), iso(stime).replace('T', ' ').replace('.000Z', ' UTC'))
    .replace(iso(etime), iso(etime).replace('T', ' ').replace('.000Z', ' UTC'));
  const submission = { text: JSON.stringify(answer) };
  const limited = await verifyCpuAnswer(relative, input, submission, reference);
  assert.equal(limited.mcp.reason, 'MCP_PERIOD_PRECISION_LIMIT');
  assert.equal(limited.ai.status, 'UNVERIFIABLE');

  input.result.content[0].text = input.result.content[0].text.replace('12.23', '99.00');
  const defective = await verifyCpuAnswer(relative, input, submission, reference);
  assert.equal(defective.mcp.reason, 'FIELD_MISMATCH');
  assert.equal(defective.mcp.status, 'FAIL');
});

test('CPU answer processing retains a verified MCP key defect without an HTTP reference', async () => {
  const input = capture([...rows.slice(0, -1), rows[0]]);
  const { mcp, ai } = await check(answer, input, { ok: true, status: 200, body: [] });
  assert.equal(mcp.status, 'FAIL');
  assert.equal(mcp.reason, 'MCP_RECORD_IDENTITIES_INVALID');
  assert.equal(ai.status, 'UNVERIFIABLE');
});
