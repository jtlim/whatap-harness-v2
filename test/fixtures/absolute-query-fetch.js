import assert from 'node:assert/strict';

const origin = 'https://fixture.invalid';
const stime = Date.parse('2026-01-01T00:00:00.125Z');
const etime = Date.parse('2026-01-01T00:15:00.750Z');

globalThis.fetch = async (input, request) => {
  const url = new URL(input);
  assert.equal(url.origin, origin);
  if (url.pathname === '/open-mcp/api/json/projects') {
    return Response.json([{ projectCode: 1, apiToken: 'fixture-project' }]);
  }
  assert.equal(request.method, 'POST');
  const { mql, stime: start, etime: end, limit } = JSON.parse(request.body);
  assert.deepEqual([start, end, limit], [stime, etime, 10]);
  const time = stime + 5000;
  if (mql === 'OPENMX fixture_cpu') {
    assert.equal(url.pathname, '/open-mcp/api/flush/mxql/text');
    return Response.json([{ time, value: 12, host: 'fixture' }]);
  }
  assert.equal(mql, '/v2/sys/server_base');
  assert.equal(url.pathname, '/open-mcp/api/flush/mxql/path');
  return Response.json([{ time, _id_: 'fixture', cpu: 12, memory_pused: 34 }]);
};
