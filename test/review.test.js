import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonEvidence } from '../lib/comparison-evidence.js';
import { buildReview, sections } from '../lib/review.js';

const before = 'a'.repeat(40), after = 'b'.repeat(40), harness = 'c'.repeat(40);
const window = { stime: 1735689600000, etime: 1735689900000 };
const scenario = { id: 'server-relative', matchKeys: ['time', '_id_'], compareFields: ['cpu'] };
const row = (id, cpu) => ({ time: window.stime, _id_: id, cpu });
const probe = (mcp, http) => ({ id: scenario.id, phase: 'audit', status: 'PASS', reason: 'ROWS_AND_PERIOD_MATCH',
  checks: [{ code: 'FIELD_VALUES' }], evidence: { args: { timeRange: '5m' }, mcpText: 'private response',
    mcpPeriod: window, mcpRows: mcp, reference: { status: 200, ok: true, body: http } } });

test('comparison evidence separates normalization from raw error and accounts for every identity', () => {
  const a = comparisonEvidence(probe(
    [row('both', '1.24'), row('bad', '8'), row('MCP', 1), row('duplicate', 1), row('duplicate', 1)],
    [row('both', 1.239), row('bad', 3), row('HTTP', 2), row('duplicate', 1), { time: window.stime }]),
    scenario);
  assert.equal(a.comparedRows, 2);
  assert.equal(a.matchedRows, 1);
  assert.equal(a.mismatchedRows, 1);
  assert.equal(a.identities.httpOnly, 1);
  assert.equal(a.identities.mcpOnly, 1);
  assert.equal(a.identities.mcpDuplicateRows, 1);
  assert.equal(a.identities.httpMissingKeys, 1);
  assert.equal(a.samples[0].status, 'DIFFER');
  assert.ok(a.samples.some(s => s.status === 'MATCH' && s.rawDifference !== 0 && s.normalizedDifference === 0));
});

test('a rejected query reports the HTTP control and never invents candidate rows', () => {
  const p = probe(null, [row('reference', 1)]);
  p.reason = 'ABSOLUTE_RANGE_REJECTED';
  p.evidence.mcpIsError = true;
  const a = comparisonEvidence(p, scenario);
  assert.equal(a.mcpRows, null);
  assert.equal(a.httpRows, 1);
  assert.equal(a.comparedRows, undefined);
  assert.equal(a.comparisonUnavailable, p.reason);
});

test('review gates sections, disclosure and live evidence and keeps actual rows local', () => {
  const manifest = { kind: 'mcp', baselineCommit: before, candidateCommit: after, harnessCommit: harness,
    publicReviewed: true, publishCounts: true, sections: Object.fromEntries(Object.keys(sections).map(k => [k, '검토 문장'])) };
  const makeRun = (role, commit) => ({ role, run: { id: role, mode: 'live', status: 'VERIFIED', harness,
    finishedAt: '2025-01-01', target: { commit, dirty: false }, events: [], conditions: { cases: [scenario] },
    probes: [probe([row('private-id', '13.37')], [row('private-id', 13.37)])] } });
  const runs = [makeRun('before', before), makeRun('after', after)];
  const attachments = [{ label: 'test', path: 'local-run.log', sha256: 'd'.repeat(64) }];
  const report = buildReview(manifest, runs, attachments);
  assert.match(report.local, /private-id/);
  assert.doesNotMatch(report.body, /private-id|13\.37|local-run\.log|private response/);
  assert.throws(() => buildReview({ ...manifest, publicReviewed: false }, runs, attachments), /DISCLOSURE/);
  assert.throws(() => buildReview({ ...manifest, sections: {} }, runs, attachments), /SECTION_MISSING/);
  assert.throws(() => buildReview(manifest, runs.slice(0, 1), attachments), /EVIDENCE_REQUIRED after/);
  assert.throws(() => buildReview(manifest, [runs[0], { ...runs[1], run: { ...runs[1].run, mode: 'replay' } }], attachments),
    /EVIDENCE_REQUIRED after/);
});

test('review rejects different fixed control windows and requires a Harness comparison attachment', () => {
  const sectionsFilled = Object.fromEntries(Object.keys(sections).map(k => [k, '검토 문장']));
  const manifest = { kind: 'audit', baselineCommit: before, candidateCommit: after,
    harnessCommit: harness, publicReviewed: true, sections: sectionsFilled };
  const makeRun = (role, day) => {
    const p = probe([row('key', 12)], [row('key', 12)]);
    p.evidence.args.timeRange = `2025-01-${day}T00:00:00.000Z/2025-01-${day}T00:05:00.000Z`;
    return { role, run: { id: role, status: 'VERIFIED', finishedAt: '2025-01-01',
      events: [], conditions: { cases: [{ ...scenario, fixed: window }] }, probes: [p] } };
  };
  const attachments = [{ role: 'test', label: 'test', path: 'local.log', sha256: 'd'.repeat(64) }];
  assert.throws(() => buildReview(manifest, [makeRun('before', '01'), makeRun('after', '02')], attachments),
    /FIXED_REVIEW_WINDOW_MISMATCH/);
  assert.throws(() => buildReview({ ...manifest, kind: 'harness' }, [], attachments),
    /SAME_INPUT_COMPARISON_ATTACHMENT_REQUIRED/);
});

test('explicit approval produces numeric evidence with stable aliases and strips the original identity and time', () => {
  const manifest = { kind: 'audit', baselineCommit: before, candidateCommit: after, harnessCommit: harness,
    publicReviewed: true, sections: Object.fromEntries(Object.keys(sections).map(k => [k, '검토 문장'])),
    publishSamples: ['before', 'after'].map(runId => ({ runId, probeIndex: 0, fields: ['cpu'], authorization: 'approval-1' })) };
  const runs = ['before', 'after'].map(role => ({ role, run: { id: role, status: 'VERIFIED',
    finishedAt: '2025-01-02', events: [], conditions: { cases: [scenario] },
    probes: [probe([row('private-key', '53.13')], [row('private-key', 53.129)])] } }));
  const attachments = [{ label: 'comparison' }];
  const result = buildReview(manifest, runs, attachments);
  const aliases = result.body.match(/행-[0-9a-f]+/g);
  assert.equal(aliases.length, 2);
  assert.equal(aliases[0], aliases[1]);
  assert.match(result.body, /53\.129/);
  assert.doesNotMatch(result.body, /private-key|2025-01-01|approval-1/);
  assert.match(result.local, /private-key/);
  assert.match(result.local, /2025-01-01/);
  assert.throws(() => buildReview({ ...manifest, publishSamples: [{ ...manifest.publishSamples[0], authorization: '' }] },
    runs, attachments), /INVALID_SAMPLE_APPROVAL/);
  assert.throws(() => buildReview({ ...manifest, publishSamples: [{ ...manifest.publishSamples[0], fields: ['_id_'] }] },
    runs, attachments), /INVALID_SAMPLE_APPROVAL/);
});

test('rejected MCP cases show up to five real HTTP reference cells and leave MCP empty', () => {
  const p = probe(null, Array.from({ length: 7 }, (_, i) => row('reference-' + i, 10 + i)));
  p.reason = 'ABSOLUTE_RANGE_REJECTED';
  p.evidence.mcpIsError = true;
  const { samples } = comparisonEvidence(p, scenario);
  assert.equal(samples.length, 5);
  assert.deepEqual(samples[0], { time: window.stime, key: JSON.stringify([String(window.stime), 'reference-0']),
    field: 'cpu', http: 10, status: 'HTTP_REFERENCE_ONLY' });
});
