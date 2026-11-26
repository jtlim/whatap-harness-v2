import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StdioMcpClient } from '../lib/mcp.js';
import { parseMcpPeriod } from '../lib/period.js';

const target = process.env.WHATAP_ABSOLUTE_MCP;
const preload = new URL('./fixtures/absolute-query-fetch.js', import.meta.url);
const bounds = ['2026-01-01T00:00:00.125Z', '2026-01-01T00:15:00.750Z'];
const [stime, etime] = bounds.map(Date.parse);
const timeRange = bounds.join('/');

test('absolute MXQL and PromQL forward identical millisecond ranges and reject malformed input',
  { skip: target ? false : 'set WHATAP_ABSOLUTE_MCP to an absolute-time candidate checkout' }, async () => {
    const client = new StdioMcpClient(resolve(target, 'dist/index.js'), 5000, {
      PATH: process.env.PATH, WHATAP_API_TOKEN: 'fixture-account', WHATAP_API_URL: 'https://fixture.invalid',
      NODE_OPTIONS: '--import=' + JSON.stringify(fileURLToPath(preload)),
    }, AbortSignal.timeout(30_000));
    try {
      await client.start();
      const call = args => client.callTool('whatap_query_data', { projectCode: 1, limit: 10, timeRange, ...args });
      for (const route of [{ path: 'v2/sys/server_base' }, { query: 'fixture_cpu' }]) {
        const first = await call(route);
        assert.notEqual(first.isError, true);
        const period = parseMcpPeriod(first.content.map(part => part.text).join('\n'));
        assert.deepEqual([period?.stime, period?.etime], [stime, etime]);
        assert.deepEqual(await call(route), first);
        for (const invalid of [`15m/${bounds[1]}`, `bad-date/${bounds[1]}`, [bounds[1], bounds[0]].join('/')]) {
          const result = await call({ ...route, timeRange: invalid });
          assert.equal(result.isError, true);
          assert.match(result.content.map(part => part.text).join('\n'), /invalid time range format/i);
        }
      }
    } finally {
      await client.close();
    }
  });
