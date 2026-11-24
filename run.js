import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { command } from './lib/process.js';
import { ReferenceApi } from './lib/http.js';
import { StdioMcpClient } from './lib/mcp.js';
import { argumentsFor, invalidApmRange, probe, query } from './lib/probe.js';
import { baseline, scenarios } from './lib/scenarios.js';
import { publicReport, saveReport } from './lib/report.js';

process.umask(0o077);
const root = fileURLToPath(new URL('.', import.meta.url));
const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'config.local.json' },
  'local-source': { type: 'string' },
  'build-only': { type: 'boolean' },
  'offline-install': { type: 'boolean' },
  'failure-example': { type: 'boolean' },
  'agent-smoke': { type: 'boolean' },
} });

await mkdir(join(root, 'runs'), { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(root, 'runs', new Date().toISOString().replace(/[:.]/g, '-') + '-'));
const id = directory.split('/').at(-1);
const run = { id, status: 'UNVERIFIABLE', baseline, events: [], probes: [], agentNotes: [] };
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
  '-c', 'mcp_servers={}', '-c', 'shell_environment_policy.inherit=none'];
const gitCredentials = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
const secrets = ['WHATAP_API_TOKEN', 'WHATAP_HTTP_API_TOKEN', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']
  .map(key => process.env[key]).filter(Boolean);
let api;
const redact = text => {
  for (const token of secrets) text = text.replaceAll(token, '[REDACTED]');
  return api?.redact(text) ?? text;
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

async function candidatePaths(worktree, attempt, allowDist = false) {
  const changed = (await step('diff-paths', 'git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: worktree })).split('\0');
  const added = (await step('new-paths', 'git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktree })).split('\0');
  const paths = [...new Set([...changed, ...added].filter(Boolean))].sort();
  if (!paths.some(path => path.startsWith('src/')) ||
      !paths.every(path => /^(?:src|tests)\/[\w./-]+\.ts$/.test(path) ||
        (allowDist && /^dist\/index\.(?:js|js\.map|d\.ts)$/.test(path))) ||
      changed.some(path => path.startsWith('tests/'))) {
    throw new RunFailure('VALIDATION_FAILED', 'CANDIDATE_SCOPE_INVALID');
  }
  for (const path of paths) {
    const info = await lstat(join(worktree, path)).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw new RunFailure('VALIDATION_FAILED', 'CANDIDATE_FILE_TYPE');
    if (!path.startsWith('dist/')) {
      const content = await readFile(join(worktree, path), 'utf8');
      if (redact(content) !== content || /gh[pousr]_[a-zA-Z0-9]{25,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}/.test(content)) {
        throw new RunFailure('VALIDATION_FAILED', 'CREDENTIAL_IN_CANDIDATE');
      }
    }
  }
  await step('diff-include-additions', 'git', ['add', '--intent-to-add', '--', ...paths], { cwd: worktree });
  const patch = await step('candidate-diff', 'git', ['diff', '--no-ext-diff', '--binary', 'HEAD'], {
    cwd: worktree, privateOutput: true,
  });
  await writeFile(join(directory, `candidate-${attempt}${allowDist ? '-verified' : ''}.patch`), redact(patch));
  return paths;
}

async function batch(worktree, configuration, cases, phase, negative = false) {
  const env = { ...toolsEnv, WHATAP_API_TOKEN: process.env.WHATAP_API_TOKEN,
    WHATAP_API_URL: configuration.apiOrigin ?? 'https://api.whatap.io' };
  const client = new StdioMcpClient(join(worktree, 'dist/index.js'), 45_000, env);
  try {
    await client.start();
    const result = [];
    for (const scenario of cases) result.push(await probe(client, api, scenario));
    if (negative) result.push(await invalidApmRange(client, cases.find(s => s.statisticsMode)));
    for (const item of result) {
      run.probes.push({ ...item, phase });
      event(phase + '/' + item.id, item.status, item.reason);
    }
    return result;
  } finally {
    await client.close();
  }
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

  const cases = scenarios(config);
  const target = cases.find(s => s.repairTarget);
  run.conditions = { fork: config.fork, baseBranch: config.baseBranch, cases };
  const url = `https://github.com/${config.fork}.git`;
  const worktree = join(directory, 'mcp');
  let actor;
  if (!values['build-only']) {
    if ((await step('harness-clean', 'git', ['status', '--porcelain'], { cwd: root })).trim()) {
      throw new RunFailure('UNVERIFIABLE', 'HARNESS_WORKTREE_DIRTY');
    }
    if (!process.env.WHATAP_API_TOKEN || !process.env.WHATAP_HTTP_API_TOKEN) {
      throw new RunFailure('UNVERIFIABLE', 'WHATAP_DEMO_TOKENS_MISSING');
    }
    api = new ReferenceApi(process.env.WHATAP_HTTP_API_TOKEN, config.apiOrigin);
    await api.connect([...new Set(cases.map(s => s.projectCode))]);
    event('whatap-read-only-access', 'PASS');
    actor = JSON.parse(await step('github-user', 'gh', ['api', 'user', '--jq', '{login,id}'],
      { env: ghEnv, privateOutput: true }));
    if (!/^[\w-]+$/.test(actor.login ?? '') || !Number.isSafeInteger(actor.id)) {
      throw new RunFailure('UNVERIFIABLE', 'GITHUB_ACTOR_UNAVAILABLE');
    }
    const remote = JSON.parse(await step('fork-preflight', 'gh', ['api', 'repos/' + config.fork],
      { env: ghEnv, privateOutput: true }));
    if (!remote.fork || remote.parent?.full_name.toLowerCase() !== 'whatap/whatap-open-mcp' ||
        !remote.permissions?.push) {
      throw new RunFailure('UNVERIFIABLE', 'FORK_WRITE_OR_PARENT_UNVERIFIED');
    }
    const base = (await step('fork-base', 'gh', ['api', 'repos/' + config.fork + '/git/ref/heads/' + config.baseBranch,
      '--jq', '.object.sha'], { env: ghEnv })).trim();
    if (base !== baseline) throw new RunFailure('UNVERIFIABLE', 'FORK_BASE_NOT_PINNED');
    await step('agent-auth', 'codex', ['login', 'status'], {
      env: { ...toolsEnv, ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) },
      failureStatus: 'AI_FAILED', privateOutput: true,
    });
  }
  const source = values['local-source'] ? resolve(values['local-source']) : url;
  await step('mcp-clone', 'git', [...gitCredentials, 'clone', '--no-local', '--no-checkout', '--', source, worktree],
    { env: ghEnv, timeout: 180_000 });
  const branch = 'harness-v2/' + id;
  await step('mcp-baseline', 'git', ['switch', '-c', branch, baseline], { cwd: worktree });
  await step('mcp-install', 'npm', ['ci', '--no-audit', '--no-fund',
    ...(values['offline-install'] ? ['--offline', '--ignore-scripts'] : [])], { cwd: worktree, env: npmEnv, timeout: 180_000 });
  await step('mcp-baseline-build', 'npm', ['run', 'build'], { cwd: worktree, env: npmEnv, timeout: 120_000 });
  await step('mcp-baseline-tests', 'npm', ['test'], { cwd: worktree, env: npmEnv, timeout: 120_000 });
  if (values['build-only']) {
    const client = new StdioMcpClient(join(worktree, 'dist/index.js'), 5_000, {
      ...toolsEnv, WHATAP_API_TOKEN: 'local-parser-only', WHATAP_API_URL: 'http://127.0.0.1:9',
    });
    try {
      await client.start();
      const result = await client.callTool(query, argumentsFor(target));
      const rejected = result.isError === true &&
        result.content?.some(part => /invalid time range format/i.test(part.text ?? ''));
      event('mcp-stdio-baseline-range', rejected ? 'PASS' : 'ERROR');
      if (!rejected) throw new RunFailure('UNVERIFIABLE', 'BASELINE_RANGE_SMOKE_UNEXPECTED');
    } finally {
      await client.close();
    }
    run.status = 'BUILD_ONLY';
    return;
  }

  const baselineCases = cases.map(s => s.statisticsMode ? { ...s, fixed: undefined, timeRange: '15m' } : s);
  const before = await batch(worktree, config, baselineCases, 'before', true);
  const failure = before.find(r => r.id === target.id);
  if (failure?.status !== 'FAIL' || failure.reason !== 'ABSOLUTE_RANGE_REJECTED') {
    throw new RunFailure('UNVERIFIABLE', 'REPAIR_TARGET_NOT_REPRODUCED');
  }

  await step('restore-baseline-dist', 'git', ['restore', '--source=HEAD', '--', 'dist'], { cwd: worktree });
  const prompt = [
    'Analyze and repair the observed functional defect in this WhaTap MCP checkout.',
    'The independent direct HTTP MXQL reference returned nonempty rows for a fixed historical UTC interval.',
    'The MCP whatap_query_data call rejected the same interval with Invalid time range format.',
    'Its timeRange argument now needs to support an explicit ISO 8601 UTC start/end interval,',
    'formatted as 2025-01-01T00:00:00.000Z/2025-01-01T00:15:00.000Z.',
    'Preserve all relative queries, strict input validation, error and limit reporting.',
    'The harness parses only the displayed Period and calls its own reference API.',
    'Do not change validation criteria, contact services, or commit. Edit src/*.ts (including subdirs)',
    'and optionally add tests/*.ts. Keep existing tests intact. Leave dist to the harness.',
    'Report your actual diagnosis, rationale, files and limits in Korean without credentials or service data.',
  ].join('\n');

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const note = await step('agent-' + attempt, 'codex', [...codexArgs, '-s', 'workspace-write', '-C', worktree,
        '-c', 'sandbox_workspace_write.network_access=false', '-'], {
        cwd: worktree, input: prompt + (attempt > 1 ? '\nRetry after: ' + run.lastFailure : ''),
        env: agentEnv, timeout: 480_000, failureStatus: 'AI_FAILED',
      });
      run.agentNotes.push(note.trim());
      await candidatePaths(worktree, attempt);
      await step('mcp-candidate-build-' + attempt, 'npm', ['run', 'build'], {
        cwd: worktree, env: npmEnv, timeout: 120_000, failureStatus: 'VALIDATION_FAILED',
      });
      await step('mcp-regression-tests-' + attempt, 'npm', ['test'], {
        cwd: worktree, env: npmEnv, timeout: 120_000, failureStatus: 'VALIDATION_FAILED',
      });
      const after = await batch(worktree, config, cases, 'after-' + attempt, true);
      const problems = after.filter(result => result.status !== 'PASS');
      if (problems.length) {
        throw new RunFailure(problems.some(p => p.status === 'FAIL') ? 'VALIDATION_FAILED' : 'UNVERIFIABLE',
          problems.map(p => `${p.id}/${p.reason}`).join(','));
      }
      const relativeApm = await batch(worktree, config, baselineCases.filter(s => s.statisticsMode),
        'after-relative-apm-' + attempt);
      if (relativeApm.some(result => result.status !== 'PASS')) {
        throw new RunFailure(relativeApm.some(p => p.status === 'FAIL') ? 'VALIDATION_FAILED' : 'UNVERIFIABLE',
          relativeApm.filter(p => p.status !== 'PASS').map(p => `${p.id}/${p.reason}`).join(','));
      }
      run.files = await candidatePaths(worktree, attempt, true);
      break;
    } catch (error) {
      run.lastFailure = String(error.message);
      event('attempt-' + attempt, error.status ?? 'UNVERIFIABLE', run.lastFailure);
      if (attempt === 2 || error.status === 'UNVERIFIABLE' || !error.status) throw error;
      // A retry starts with clean tracked state and removes only files inside this disposable clone.
      await step('retry-reset', 'git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.'], { cwd: worktree });
      await step('retry-clean', 'git', ['clean', '-fd'], { cwd: worktree });
      run.files = undefined;
    }
  }
  run.status = 'VERIFIED';
  await saveReport(directory, run, redact);

  const owner = config.fork.split('/')[0];
  // gh does not need the candidate's origin to create a PR. The destination
  // is the validated fork and the base SHA was checked against the pinned ref.
  await step('stage-verified-files', 'git', ['add', '--', ...run.files],
    { cwd: worktree, failureStatus: 'SUBMISSION_FAILED' });
  await step('mcp-commit', 'git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=' + actor.login, '-c', 'user.email=' + actor.id + '+' + actor.login + '@users.noreply.github.com', 'commit', '-m',
    'Support and independently verify fixed WhaTap MCP query windows'],
    { cwd: worktree, failureStatus: 'SUBMISSION_FAILED' });
  run.mcpCommit = (await step('mcp-commit-sha', 'git', ['rev-parse', 'HEAD'], { cwd: worktree })).trim();
  const base = (await step('fork-base-before-push', 'gh', ['api',
    'repos/' + config.fork + '/git/ref/heads/' + config.baseBranch, '--jq', '.object.sha'],
    { env: ghEnv, failureStatus: 'SUBMISSION_FAILED' })).trim();
  if (base !== baseline) throw new RunFailure('SUBMISSION_FAILED', 'FORK_BASE_MOVED');
  await step('mcp-push', 'git', [...gitCredentials, 'push', url, `HEAD:refs/heads/${branch}`],
    { cwd: worktree, env: ghEnv, timeout: 120_000, failureStatus: 'SUBMISSION_FAILED' });
  const prBody = join(directory, 'pr-body.md');
  const design = '## 변경 내용\n\nwhatap_query_data의 timeRange에 UTC ISO 8601 시작/종료 구간을 추가했습니다. ' +
    'MCP가 거부하던 동일 절대 구간을 독립 HTTP 기준 데이터로 확인했습니다. 기존 상대시간은 각 응답 Period와 비교했습니다. ' +
    '전체 MCP 테스트, 서버 지표, APM 통계 및 오류 처리, 5초 시계열 검증을 완료했습니다.\n';
  await writeFile(prBody, publicReport(run) + '\n' + design);
  run.pr = (await step('mcp-pr', 'gh', ['pr', 'create', '--repo', config.fork,
    '--base', config.baseBranch, '--head', owner + ':' + branch,
    '--title', 'Support fixed UTC query windows in whatap_query_data',
    '--body-file', prBody], { cwd: worktree, env: ghEnv, timeout: 90_000,
    failureStatus: 'SUBMISSION_FAILED' })).trim();
  if (!/^https:\/\/github\.com\/[\w-]+\/whatap-open-mcp\/pull\/\d+$/i.test(run.pr)) {
    throw new RunFailure('SUBMISSION_FAILED', 'PR_URL_MISSING');
  }
  run.status = 'SUBMITTED';
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
