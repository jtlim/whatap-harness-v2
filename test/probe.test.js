import test from 'node:test';
import assert from 'node:assert/strict';
import { probe as liveProbe, invalidApmRange } from '../lib/probe.js';
import { compareApmV2 } from '../lib/apm.js';
import { parseMcpPeriod } from '../lib/period.js';
import { ReferenceApi } from '../lib/http.js';
import { scenarios, validationScenarios } from '../lib/scenarios.js';

const start = Date.UTC(2026, 10, 24, 9, 0);
const end = start + 10_000;
const probe = (client, api, scenario, now = () => end) => liveProbe(client, api, scenario, { now });
const utc = time => new Date(time).toISOString().replace('T', ' ').replace('Z', ' UTC');
const period = `**Period**: ${utc(start)} → ${utc(end)}`;
const series = { id: 'series', domain: 'timeseries', projectCode: 1, path: 'v2/app/tps_pcode',
  matchKeys: ['time', '_id_'], compareFields: ['tps'], expectedStepMs: 5000, limit: 5, timeRange: '10s' };
const reference = [
  { time: start, _id_: 'stable', tps: 1.2345 },
  { time: start + 5000, _id_: 'stable', tps: 2 },
];
const http = rows => ({ ok: true, status: 200, body: rows });
const tool = (text, isError = false) => ({ callTool: async () => ({
  isError, content: [{ type: 'text', text }],
  structuredContent: { stime: start + 444, etime: end + 444 },
}) });
const table = (rows, keys) => [
  '| ' + keys.join(' | ') + ' |', '| ' + keys.map(() => '---').join(' | ') + ' |',
  ...rows.map(row => '| ' + keys.map(key => key === 'time' ? utc(row.time).replace('.000', '') : row[key]).join(' | ') + ' |'),
].join('\n');
const texts = rows => period + '\n\n' + table(rows, ['time', '_id_', 'tps']);

test('relative comparison uses the displayed Period exactly and honors display rounding', async () => {
  const candidate = tool(texts([{ ...reference[0], tps: '1.23' }, reference[1]]));
  const result = await probe(candidate, { mxql: async (scenario, window) => {
    assert.equal(scenario.projectCode, 1);
    assert.deepEqual({ stime: window.stime, etime: window.etime }, { stime: start, etime: end });
    return http(reference);
  } }, series);
  assert.equal(result.status, 'PASS');
});

test('Period keeps milliseconds and rejects impossible or ambiguous dates', () => {
  const withMillis = period.replaceAll('.000', '.127');
  assert.equal(parseMcpPeriod(withMillis).stime, start + 127);
  const mixedPrecision = `**Period**: ${utc(start).replace('.000', '')} → ${utc(end + 375)}`;
  assert.deepEqual(parseMcpPeriod(mixedPrecision), { label: mixedPrecision, stime: start, etime: end + 375 });
  assert.equal(parseMcpPeriod(period + '\n' + period), null);
  assert.equal(parseMcpPeriod(period.replaceAll('11-24', '02-31')), null);
});

test('relative comparison sends the ISO Period milliseconds to independent HTTP', async () => {
  const stime = start + 375;
  const etime = end + 375;
  const label = `**Period**: ${new Date(stime).toISOString()} → ${new Date(etime).toISOString()}`;
  const rows = [{ ...reference[0], time: start + 5000 }, { ...reference[1], time: end }];
  const markdown = label + '\n\n' + table([{ ...rows[0], tps: '1.23' }, rows[1]], ['time', '_id_', 'tps']);
  const result = await probe(tool(markdown), { mxql: async (_scenario, window) => {
    assert.deepEqual(window, { label, stime, etime });
    return http(rows);
  } }, series, () => etime);
  assert.equal(result.status, 'PASS');
  assert.equal(parseMcpPeriod(label.replaceAll('11-24', '02-31')), null);
  assert.equal(parseMcpPeriod(period + '\n' + label), null);
});

test('Server Absolute requests enough rows for the full 15-minute comparison', async () => {
  const fixedEnd = start + 900_000;
  const scenario = scenarios({ serverProject: 1, fixedEnd }).find(s => s.id === 'server-absolute');
  const rows = Array.from({ length: 900 }, (_, i) => ({
    time: start + i * 1000, _id_: 'synthetic-server', cpu: 12.34, memory_pused: 56.78,
  }));
  const label = `**Period**: ${utc(start)} → ${utc(fixedEnd)}`;
  const keys = ['time', '_id_', 'cpu', 'memory_pused'];
  const api = { mxql: async (_scenario, window) => {
    assert.deepEqual(window, { stime: start, etime: fixedEnd });
    return http(rows);
  } };
  const client = { callTool: async (_name, { limit, timeRange }) => {
    assert.equal(limit, 1000);
    assert.equal(timeRange, `${new Date(start).toISOString()}/${new Date(fixedEnd).toISOString()}`);
    return tool(label + '\n\n' + table(rows.slice(0, limit), keys)).callTool();
  } };
  assert.equal((await probe(client, api, scenario)).reason, 'ROWS_AND_PERIOD_MATCH');

  const truncated = tool(label + '\n\n' + table(rows.slice(0, 500), keys) + '\n\nResult may be truncated');
  assert.equal((await probe(truncated, api, scenario)).reason, 'MISSING_OR_EXTRA_RECORDS');
});

test('relative query without Period does not make a reference call', async () => {
  const result = await probe(tool('empty'), {}, series);
  assert.equal(result.reason, 'MCP_PERIOD_INVALID');
});

test('missing MCP rows fail and missing HTTP grid is unverifiable', async () => {
  const candidate = tool(texts([{ ...reference[0], tps: '1.23' }]));
  const missingMcp = await probe(candidate, { mxql: async () => http(reference) }, series);
  const missingHttp = await probe(candidate, { mxql: async () => http(reference.slice(0, 1)) }, series);
  assert.equal(missingMcp.reason, 'MISSING_OR_EXTRA_RECORDS');
  assert.equal(missingHttp.reason, 'HTTP_REFERENCE_INCOMPLETE');
});

test('only a verified fixed-window control classifies a period rejection as a defect', async () => {
  const candidate = tool('Invalid time range format', true);
  const fixed = { stime: start, etime: end };
  const scenario = { ...series, fixed };
  assert.equal((await probe(candidate, { mxql: async () => http(reference) }, scenario)).reason,
    'ABSOLUTE_RANGE_REJECTED');
  assert.equal((await probe(candidate, { mxql: async () => http([]) }, scenario)).status, 'UNVERIFIABLE');
});

test('invalid APM range assertion distinguishes a validation error from auth errors', async () => {
  assert.equal((await invalidApmRange(tool('Invalid time range format', true), series)).status, 'PASS');
  assert.equal((await invalidApmRange(tool('Authentication failed', true), series)).status, 'FAIL');
});

test('APM display limits must be explicit and identity/value checks still run', async () => {
  const settings = { ...series, domain: 'apm', statisticsMode: 'transaction', groupKeys: ['_id_'], limit: 1 };
  const one = { ...reference[0], tps: '1.23' };
  const api = { mxql: async () => http(reference) };
  const noDisclosure = await probe(tool(texts([one])), api, settings);
  const disclosed = await probe(tool(texts([one]) + '\n\nResult may be truncated'), api, settings);
  const wrong = await probe(tool(texts([{ ...one, tps: '10' }]) + '\n\nResult may be truncated'), api, settings);
  assert.equal(noDisclosure.reason, 'APM_UNDISCLOSED_OR_PREMATURE_LIMIT');
  assert.equal(disclosed.reason, 'DISCLOSED_SAMPLE_MATCH');
  assert.equal(wrong.reason, 'FIELD_MISMATCH');
});

test('APM v2 verifies full same-window bucket groups and handles divergent references', () => {
  const scope = { stime: start, etime: start + 300_000 };
  const rows = [{ time: start, tx_hash: 1, tx_count: 2, tx_error: 1, tx_time_sum: 4 }];
  const result = http({ total: 1, retrievedTotal: 1, data: [{ serviceHash: 1, count: 2, error: 1, timeSum: 4 }] });
  const scenario = { statisticsMode: 'transaction' };
  assert.equal(compareApmV2(scenario, rows, result, scope).verdict, 'PASS');
  result.body.data[0].count = 7;
  assert.equal(compareApmV2(scenario, rows, result, scope).reason, 'REFERENCE_INCONSISTENCY');
  result.body.total = 3;
  assert.equal(compareApmV2(scenario, rows, result, scope).reason, 'APM_V2_INCOMPLETE');
});

test('reference sends credentials only to HTTP and strips returned token strings from evidence', async () => {
  const calls = [];
  const account = 'demo-account-secret';
  const project = 'demo-project-secret';
  const fetchFn = async (url, request) => {
    calls.push({ url, request });
    const data = calls.length === 1
      ? [{ projectCode: 1, apiToken: project }]
      : [{ _id_: 'x', note: project, time: start, tps: 2 }];
    return new Response(JSON.stringify(data));
  };
  const api = new ReferenceApi(account, 'https://example.test', fetchFn);
  await api.connect([1]);
  const result = await api.mxql(series, { stime: start, etime: end });
  assert.equal(calls[0].request.headers['x-whatap-token'], account);
  assert.equal(calls[1].request.headers['x-whatap-token'], project);
  assert.equal(calls[1].request.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[1].request.body), {
    pageKey: 'mxql', mql: '/v2/app/tps_pcode', stime: start, etime: end,
  });
  assert.equal(result.body[0].note, '[REDACTED]');
  assert.match(api.redact('stime etime'), /stime etime/);
});

test('the rendered metric summary is checked against independent unrounded values', async () => {
  const text = texts([{ ...reference[0], tps: '1.23' }, reference[1]]);
  const api = { mxql: async () => http(reference) };
  const right = await probe(tool(text + '\n\n**Summary** (2 rows): **tps** (1.2–2, avg 1.6)'), api, series);
  const wrong = await probe(tool(text + '\n\n**Summary** (2 rows): **tps** (1.2–2, avg 9.9)'), api, series);
  assert.equal(right.status, 'PASS');
  assert.equal(wrong.reason, 'MCP_SUMMARY_MISMATCH');
});

test('a stale, future, malformed or wrong-duration Period fails before HTTP', async () => {
  const api = { mxql: () => assert.fail('invalid Period must never select the reference window') };
  const text = texts(reference);
  for (const [markdown, now, reason] of [
    [text, end + 1000, 'MCP_PERIOD_OUTSIDE_CALL'],
    [text, end - 1, 'MCP_PERIOD_OUTSIDE_CALL'],
    [text.replace(utc(end), utc(end - 1000)), end, 'MCP_PERIOD_MISMATCH'],
    [text.replaceAll(' UTC', ' KST'), end, 'MCP_PERIOD_INVALID'],
    [text + '\n**Period**: invalid', end, 'MCP_PERIOD_INVALID'],
  ]) {
    const result = await probe(tool(markdown), api, series, () => now);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.reason, reason);
  }
  assert.equal((await liveProbe(tool(text), api, series, { timing: null })).status, 'UNVERIFIABLE');
  assert.equal((await probe(tool('Invalid time range format', true), api, series)).status, 'FAIL');
  assert.equal((await probe(tool('No rows returned.'), api, series)).status, 'UNVERIFIABLE');
});

test('legacy seconds admit only the compatible part of the call clock', async () => {
  const text = texts([{ ...reference[0], tps: '1.23' }, reference[1]]).replaceAll('.000 UTC', ' UTC');
  const result = await probe(tool(text), { mxql: async () => http(reference) }, series, () => end + 999);
  assert.equal(result.status, 'PASS');
  const precise = await probe(tool(texts(reference)), {}, series, () => end + 1);
  assert.equal(precise.reason, 'MCP_PERIOD_OUTSIDE_CALL');
});

test('relative APM compares the full Period through MXQL and complete buckets through v2', async () => {
  const settings = { ...series, domain: 'apm', timeRange: '15m', expectedStepMs: undefined,
    statisticsMode: 'transaction', crossCheckStats: true, groupKeys: ['tx_hash'],
    matchKeys: ['time', 'tx_hash'], compareFields: ['tx_count', 'tx_error', 'tx_time_sum'] };
  const etime = start + 900_375;
  const stime = start + 375;
  const rows = [300_000, 600_000, 900_000].map(offset => ({
    time: start + offset, tx_hash: 1, tx_count: 2, tx_error: 1, tx_time_sum: 4,
  }));
  const text = `**Period**: ${utc(stime)} → ${utc(etime)}\n\n` +
    table(rows, settings.matchKeys.concat(settings.compareFields));
  const api = {
    mxql: async (_s, w) => {
      assert.deepEqual([w.stime, w.etime], [stime, etime]);
      return http(rows);
    },
    stats: async (_s, w) => {
      assert.deepEqual(w, { stime: start + 300_000, etime: start + 900_000 });
      return http({ total: 1, retrievedTotal: 1, data: [{ serviceHash: 1, count: 4, error: 2, timeSum: 8 }] });
    },
  };
  const result = await probe(tool(text), api, settings, () => etime);
  assert.equal(result.status, 'PASS');
  assert.ok(result.checks.some(c => c.code === 'APM_V2_AGGREGATES' && c.ok));
});

test('the default suite has one relative query per dataset and keeps statistics checks', () => {
  const config = { serverProject: 1, apmProject: 2, fixedEnd: start + 900_000 };
  const defaults = validationScenarios(config);
  assert.deepEqual(defaults.map(s => s.id), [
    'server-relative', 'apm-transactions', 'apm-exceptions', 'apm-tps', 'apm-error-series', 'apm-invalid-range',
  ]);
  assert.ok(defaults.every(s => !s.fixed && (s.timeRange || s.negative)));
  assert.ok(defaults.filter(s => s.statisticsMode && !s.negative).every(s => s.crossCheckStats));
  const feature = validationScenarios(config, { absolute: true });
  assert.equal(feature.filter(s => s.fixed).length, 3);
  assert.equal(feature.filter(s => s.negative && s.invalidTimeRange).length, 3);
});
