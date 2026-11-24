import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { command } from '../lib/process.js';
import { candidateScopeValid, existingTestDiff } from '../lib/scope.js';

test('post-build scope accepts intent-to-add tests and still rejects edits to original tests', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'whatap-scope-'));
  async function git(...args) {
    const result = await command('git', args, { cwd });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.split('\0').filter(Boolean);
  }
  try {
    await git('init', '-q');
    for (const directory of ['src', 'tests', 'dist']) await mkdir(join(cwd, directory));
    const source = 'src/query.ts';
    const original = 'tests/known.test.ts';
    const added = 'tests/range.test.ts';
    const dist = 'dist/index.js';
    for (const file of [source, original, dist]) await writeFile(join(cwd, file), 'original\n');
    await git('add', '.');
    await git('-c', 'user.email=tests@example.invalid', '-c', 'user.name=Tests', 'commit', '-qm', 'baseline');
    await writeFile(join(cwd, source), 'candidate\n');
    await writeFile(join(cwd, added), 'new test\n');
    await git('add', '--intent-to-add', '--', added);
    await writeFile(join(cwd, dist), 'rebuilt\n');
    const paths = await git('diff', '--name-only', '-z', 'HEAD');
    assert.ok(paths.includes(added));
    assert.ok(paths.some(path => path.startsWith('tests/')), 'previous scope rejects this input');
    assert.ok(candidateScopeValid(paths, await git(...existingTestDiff), true));
    assert.equal(candidateScopeValid(paths, [], false), false, 'dist remains forbidden before build');

    await writeFile(join(cwd, original), 'changed original test\n');
    assert.equal(candidateScopeValid([...paths, original], await git(...existingTestDiff), true), false);
    await rm(join(cwd, original));
    assert.equal(candidateScopeValid([...paths, original], await git(...existingTestDiff), true), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
