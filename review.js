import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReview } from './lib/review.js';

process.umask(0o077);
const [command, manifestPath, directory, option, policyPath] = process.argv.slice(2);
if (command !== 'build' || !manifestPath || !directory || !(process.argv.length === 5 || (process.argv.length === 7 && option === '--publication-policy' && policyPath))) {
  console.error('Usage: node review.js build MANIFEST.json NEW_OUTPUT_DIRECTORY [--publication-policy FILE]');
  process.exit(2);
}
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const root = dirname(resolve(manifestPath));
  const digest = data => createHash('sha256').update(data).digest('hex');
  const localHref = path => relative(resolve(directory), resolve(root, path))
    .split('/').map(encodeURIComponent).join('/');
  const runs = [];
  const attachments = [];
  for (const entry of manifest.runs ?? []) {
    const data = await readFile(resolve(root, entry.path));
    runs.push({ role: entry.role, run: JSON.parse(data) });
    attachments.push({ label: entry.role, path: entry.path, localHref: localHref(entry.path), sha256: digest(data) });
  }
  for (const entry of manifest.attachments ?? []) {
    const data = await readFile(resolve(root, entry.path));
    if (!entry.label || !data.length) throw Error('REVIEW_ATTACHMENT_EMPTY');
    attachments.push({ content: data.toString('utf8'), label: entry.label, role: entry.role, path: entry.path, localHref: localHref(entry.path), sha256: digest(data) });
  }
  if (manifest.kind !== 'audit' && (manifest.outcome ?? 'VERIFIED') === 'VERIFIED' && !attachments.some(a => a.role === 'test' || a.role === 'reproduction'))
    throw Error('REVIEW_TEST_OR_REPRODUCTION_ATTACHMENT_REQUIRED');
  const defaultPolicyPath = fileURLToPath(new URL('./publication.local.json', import.meta.url));
  let publicationPolicy;
  let publicationState = manifest.publicationAuthorization === 'unconfirmed'
    ? 'AUTHORIZATION_UNCONFIRMED' : 'DEFAULT_PRIVATE';
  if (policyPath && publicationState === 'AUTHORIZATION_UNCONFIRMED')
    throw Error('PUBLICATION_AUTHORIZATION_UNCONFIRMED');
  if (publicationState !== 'AUTHORIZATION_UNCONFIRMED') {
    let policyText;
    try {
      policyText = await readFile(policyPath ?? defaultPolicyPath, 'utf8');
    } catch (error) {
      if (policyPath || error.code !== 'ENOENT') throw Error('PUBLICATION_POLICY_UNREADABLE');
    }
    if (policyText !== undefined) {
      try { publicationPolicy = JSON.parse(policyText); }
      catch { throw Error('INVALID_PUBLICATION_POLICY'); }
      publicationState = 'APPROVED_POLICY';
    }
  }
  const result = buildReview(manifest, runs, attachments, publicationPolicy, publicationState);
  const tokens = ['WHATAP_API_TOKEN', 'WHATAP_HTTP_API_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY']
    .map(k => process.env[k]).filter(Boolean);
  if (tokens.some(t => result.body.includes(t)) ||
      /gh[pousr]_[a-zA-Z0-9]{25,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}/.test(result.body))
    throw Error('CREDENTIAL_IN_PUBLIC_REVIEW');
  await mkdir(directory, { mode: 0o700 });
  await writeFile(resolve(directory, 'pr-body.md'), result.body);
  await writeFile(resolve(directory, 'report.md'), result.local);
  await writeFile(resolve(directory, 'evidence.json'), JSON.stringify(result.evidence, null, 2) + '\n');
  console.log(resolve(directory, 'pr-body.md'));
} catch (error) {
  console.error(error.code ?? error.message);
  process.exitCode = 1;
}
