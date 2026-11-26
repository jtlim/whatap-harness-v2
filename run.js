import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { command } from './lib/process.js';
import { StdioMcpClient } from './lib/mcp.js';
import { invalidApmRange } from './lib/probe.js';
import { baseline, validationScenarios } from './lib/scenarios.js';
import { saveReport } from './lib/report.js';

process.umask(0o077);
const root = fileURLToPath(new URL('.', import.meta.url));
const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'config.local.json' },
  'local-source': { type: 'string' },
  'build-only': { type: 'boolean' },
  'offline-install': { type: 'boolean' },
  'failure-example': { type: 'boolean' },
  'agent-smoke': { type: 'boolean' },
  'legacy-full': { type: 'boolean' },
} });

await mkdir(join(root, 'runs'), { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, 'runs', new Date().toISOString().replace(/[:.]/g, '-') + '-'));
const id = directory.split('/').at(-1);
const run = { id, status: 'UNVERIFIABLE', baseline, startedAt: new Date().toISOString(), events: [], probes: [], agentNotes: [] };
const toolsEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
const npmEnv = { ...toolsEnv, npm_config_cache: process.env.npm_config_cache ?? join(tmpdir(), 'whatap-v2-npm-cache'),
  npm_config_update_notifier: 'false' };
const ghEnv = { ...toolsEnv, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0',
  ...Object.fromEntries(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR']
    .filter(key => process.env[key]).map(key => [key, process.env[key]])) };
const agentEnv = { ...toolsEnv,
  ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
  ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}) };
const codexArgs = ['-a', 'never', 'exec', '--ignore-user-config', '--ephemeral',
  '-c', 'mcp_servers={}', '-c', 'shell_environment_policy.inherit=none',
  '-c', 'shell_environment_policy.set.PATH="/usr/local/bin:/usr/bin:/bin"'];
const gitCredentials = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
const secrets = ['WHATAP_API_TOKEN', 'WHATAP_HTTP_API_TOKEN', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']
  .map(key => process.env[key]).filter(Boolean);
const redact = text => {
  for (const token of secrets) text = text.replaceAll(token, '[REDACTED]');
  return text;
};

function event(stage, status, detail) {
  run.events.push({ at: new Date().toISOString(), stage, status, detail });
  console.log(stage, status);
}

class RunFailure extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
  }
}

async function step(label, executable, args, options = {}) {
  const result = await command(executable, args, { env: toolsEnv, ...options });
  const ok = result.code === 0 && !result.problem;
  event(label, ok ? 'PASS' : 'ERROR', result.problem ?? `exit=${result.code}`);
  if (!options.privateOutput) {
    await writeFile(join(directory, label + '.log'), redact(result.stdout + '\n' + result.stderr));
  }
  if (!ok) throw new RunFailure(options.failureStatus ?? 'UNVERIFIABLE', label + ':' + (result.problem ?? result.code));
  return result.stdout;
}

async function main() {
  run.harness = (await step('harness-head', 'git', ['rev-parse', 'HEAD'], { cwd: root })).trim();
  if (values['failure-example']) {
    // Deterministic subprocess failure. Uses the same classifier and report path as Codex.
    await step('agent-failure-example', process.execPath, ['-e', 'process.exit(17)'],
      { failureStatus: 'AI_FAILED' });
    return;
  }
  if (values['agent-smoke']) {
    await step('agent-smoke', 'codex', [...codexArgs, '-s', 'read-only', '-C', root, '-'], {
      cwd: root, env: agentEnv, input: 'Reply READY only. Do not use tools.', timeout: 20_000,
      failureStatus: 'AI_FAILED',
    });
    run.status = 'AGENT_SMOKE_ONLY';
    return;
  }
  if (!values['build-only'] || values['legacy-full']) {
    throw new RunFailure('UNVERIFIABLE', 'USE_VERIFY_JS_FOR_EVIDENCE_LED_REVIEW');
  }
  const config = JSON.parse(await readFile(resolve(values.config), 'utf8'));
  if (!/^[\w-]+\/whatap-open-mcp$/.test(config.fork ?? '') || /^whatap\//i.test(config.fork) ||
      !/^[\w][\w./-]*$/.test(config.baseBranch ?? '') ||
      (await command('git', ['check-ref-format', 'refs/heads/' + config.baseBranch])).code !== 0) {
    throw new RunFailure('UNVERIFIABLE', 'CONFIG_FORK_OR_BRANCH');
  }
  if (![config.serverProject, config.apmProject].every(n => Number.isSafeInteger(n) && n > 0) ||
      (config.fixedEnd !== undefined && (!Number.isSafeInteger(config.fixedEnd) ||
        config.fixedEnd <= 900_000 || config.fixedEnd % 300_000 !== 0))) {
    throw new RunFailure('UNVERIFIABLE', 'CONFIG_PROJECT_OR_WINDOW');
  }

  const cases = validationScenarios(config);
  run.conditions = { fork: config.fork, baseBranch: config.baseBranch, cases };
  const url = `https://github.com/${config.fork}.git`;
  const worktree = join(directory, 'mcp');
  const source = values['local-source'] ? resolve(values['local-source']) : url;
  await step('mcp-clone', 'git', [...gitCredentials, 'clone', '--no-local', '--no-checkout', '--', source, worktree],
    { env: ghEnv, timeout: 180_000 });
  const branch = 'harness-v2/' + id;
  await step('mcp-baseline', 'git', ['switch', '-c', branch, baseline], { cwd: worktree });
  await step('mcp-install', 'npm', ['ci', '--no-audit', '--no-fund',
    ...(values['offline-install'] ? ['--offline', '--ignore-scripts'] : [])], { cwd: worktree, env: npmEnv, timeout: 180_000 });
  await step('mcp-baseline-build', 'npm', ['run', 'build'], { cwd: worktree, env: npmEnv, timeout: 120_000 });
  await step('mcp-baseline-tests', 'npm', ['test'], { cwd: worktree, env: npmEnv, timeout: 120_000 });
  const client = new StdioMcpClient(join(worktree, 'dist/index.js'), 5_000, {
    ...toolsEnv, WHATAP_API_TOKEN: 'local-parser-only', WHATAP_API_URL: 'http://127.0.0.1:9',
  });
  try {
    await client.start();
    const result = await invalidApmRange(client, cases.find(s => s.negative));
    event('mcp-stdio-baseline-invalid-input', result.status);
    if (result.status !== 'PASS') throw new RunFailure('UNVERIFIABLE', 'BASELINE_RANGE_SMOKE_UNEXPECTED');
  } finally {
    await client.close();
  }
  run.status = 'BUILD_ONLY';

}

try {
  await main();
} catch (error) {
  run.status = error.status ?? 'UNVERIFIABLE';
  event('terminal', run.status, redact(String(error?.cause?.code ?? error.message)));
  process.exitCode = 1;
} finally {
  run.finishedAt = new Date().toISOString();
  await saveReport(directory, run, redact);
  console.log(run.status, join(directory, 'report.md'));
}
