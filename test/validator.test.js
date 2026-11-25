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

test('reference-only key ambiguity is unverifiable and candidate key defects fail', () => {
  for (const [reference, candidate, status, reason, detail] of [
    [good, duplicated, 'FAIL', 'MCP_RECORD_IDENTITIES_INVALID', /API 중복=0.*MCP 중복=1/],
    [good, missing, 'FAIL', 'MCP_RECORD_IDENTITIES_INVALID', /MCP 중복=0, 식별자 누락=1/],
    [duplicated, good, 'UNVERIFIABLE', 'AMBIGUOUS_RECORD_IDENTITIES', /API 중복=1/],
    [missing, good, 'UNVERIFIABLE', 'AMBIGUOUS_RECORD_IDENTITIES', /API 중복=0, 식별자 누락=1/],
    [missing, duplicated, 'FAIL', 'MCP_RECORD_IDENTITIES_INVALID', /API 중복=0, 식별자 누락=1.*MCP 중복=1/],
  ]) {
    const result = compareRows(scenario, reference, candidate);
    assert.equal(result.status, status);
    assert.equal(result.reason, reason);
    assert.match(result.checks[0].detail, detail);
  }
});
