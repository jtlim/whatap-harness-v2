import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareRows } from '../lib/validator.js';

const scenario = { matchKeys: ['time', '_id_'], compareFields: ['cpu'] };
const first = { time: 1, _id_: '001', cpu: 10 };
const second = { time: 2, _id_: '001', cpu: 10 };
const good = [first, second];
const duplicated = [first, first];
const missing = [first, { time: 2, cpu: 10 }];

test('composite identities allow repeated components and preserve numeric normalization', () => {
  assert.equal(compareRows(scenario, good, [{ ...first, time: '1' }, second]).status, 'PASS');
  assert.equal(compareRows(scenario, good, [{ ...first, _id_: 1 }, second]).status, 'FAIL');
});

test('missing keys are separate from repeated keys', () => {
  assert.equal(compareRows(scenario, good, missing).reason, 'MCP_RECORD_IDENTITIES_INVALID');
  assert.equal(compareRows(scenario, missing, good).status, 'UNVERIFIABLE');
  assert.equal(compareRows(scenario, missing, missing).status, 'FAIL');
  assert.equal(compareRows(scenario, good, duplicated).reason, 'MISSING_OR_EXTRA_RECORDS');
});

test('compare duplicate keys as unordered multisets with record counts', () => {
  const group = values => values.map(cpu => ({ ...first, cpu }));
  for (const [a, b, status] of [
    [[10,20],[10,20],'PASS'], [[10,20],[20,10],'PASS'],
    [[10,10],[10,10],'PASS'], [[10,20],[10],'FAIL'],
    [[10,20],[10,10],'FAIL'], [[10,20],[10,20,20],'FAIL'],
    [[10,20],[10,30],'FAIL'], [[10,10],[10],'FAIL'], [[10],[10,10],'FAIL'],
  ]) {
    const result = compareRows(scenario, group(a), group(b));
    assert.equal(result.status,status);
  }
  const result = compareRows(scenario, group([10,20]), group([20,10]));
  assert.equal(result.comparison.sharedDuplicateKeys, 1);
  assert.deepEqual(result.comparison.http, { groups: 1, rows: 2, additionalRows: 1, distinctMeasurements: 1, missingKeys: 0 });
});

test('tolerance matching searches alternatives without reusing a reference row', () => {
  const group = values => values.map(cpu => ({ ...first, cpu }));
  const s = { ...scenario, absoluteTolerance: 1 };
  assert.equal(compareRows(s, group([0, 2]), group([1, 0])).status, 'PASS');
  assert.equal(compareRows(s, group([0, 3]), group([1, 1])).status, 'FAIL');
});
