import test from 'node:test';
import assert from 'node:assert/strict';
import { command } from '../lib/process.js';

test('captures stdout and stderr even after the child advances the shared file offset', async () => {
  const result = await command(process.execPath, ['-e', 'console.log("out"); console.error("err")']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'out\n');
  assert.equal(result.stderr, 'err\n');
});

test('reports a timeout and terminates the child', async () => {
  const result = await command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100 });
  assert.equal(result.problem, 'TIMEOUT');
  assert.equal(result.signal, 'SIGKILL');
});
