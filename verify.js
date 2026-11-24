import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { ReferenceApi } from './lib/http.js';
import { StdioMcpClient } from './lib/mcp.js';
import { command } from './lib/process.js';
import { invalidApmRange, probe } from './lib/probe.js';
import { saveReport } from './lib/report.js';
import { baseline, validationScenarios } from './lib/scenarios.js';

process.umask(0o077);
const root = dirname(fileURLToPath(import.meta.url));
const catalog = validationScenarios({ serverProject: 1, apmProject: 2 });
const groups = ['all', 'server', 'apm', 'timeseries', 'range'];
const options = {
  config: { type: 'string', default: join(root, 'config.local.json') },
  mcp: { type: 'string' },
  select: { type: 'string', multiple: true, default: [] },
  phase: { type: 'string', default: 'audit' },
  request: { type: 'string' },
  replay: { type: 'string' },
  'fixed-end': { type: 'string' },
};
const tokens = ['WHATAP_API_TOKEN', 'WHATAP_HTTP_API_TOKEN', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']
  .map(key => process.env[key]).filter(Boolean);
let api;
function redact(text) {
  for (const token of tokens) text = text.replaceAll(token, '[REDACTED]');
  return api?.redact(text) ?? text;
}

function matches(selection, scenario) {
  if (!selection.length || selection.includes('all')) return true;
  return selection.includes(scenario.id) || selection.includes(scenario.domain) ||
    (selection.includes('range') && !scenario.negative);
}

function classify(result) {
  const evidence = result.evidence;
  const status = evidence.reference?.status;
  if ([401, 403].includes(status) ||
      /auth|unauthori[sz]ed|forbidden/i.test(evidence.mcpIsError ? evidence.mcpText : '')) {
    return '환경·인증 문제';
  }
  if (result.status === 'PASS') return '정상 검증 통과';
  if (result.status === 'FAIL') {
    return result.reason === 'ABSOLUTE_RANGE_REJECTED' ? 'MCP 구현 결함' : '검증 실패';
  }
  if (['HTTP_REFERENCE_INCOMPLETE', 'APM_V2_REFERENCE_INCOMPLETE'].includes(result.reason)) {
    return '독립 API 기준 부족';
  }
  return '검증 불가';
}

async function gitInfo(cwd) {
  const head = await command('git', ['rev-parse', 'HEAD'], { cwd });
  if (head.code !== 0) throw new Error('GIT_HEAD_UNAVAILABLE');
  const status = await command('git', ['status', '--porcelain'], { cwd });
  if (status.code !== 0) throw new Error('GIT_STATUS_UNAVAILABLE');
  return { commit: head.stdout.trim(), dirty: Boolean(status.stdout.trim()) };
}

function runEvent(run, stage, status, detail) {
  run.events.push({ at: new Date().toISOString(), stage, status, detail });
}

function addProbe(run, phase, result) {
  run.probes.push({ ...result, phase, classification: classify(result) });
}

async function replay(run, values) {
  const input = JSON.parse(await readFile(resolve(values.replay), 'utf8'));
  const definitions = input.conditions?.cases ?? [];
  run.conditions = { sourceRun: input.id, sourceHarness: input.harness, cases: definitions };
  run.target = input.target ?? { commit: input.baseline, candidateCommit: input.mcpCommit };
  run.replay = [];
  for (const saved of input.probes ?? []) {
    const def = definitions.find(s => s.id === saved.id) ??
      (saved.id === 'apm-invalid-range' && definitions.find(s => s.statisticsMode));
    const { args, mcpText, mcpIsError, reference, referenceV2 } = saved.evidence ?? {};
    const negative = saved.id === 'apm-invalid-range';
    const scenario = { ...def, id: saved.id, negative };
    if (!matches(values.select, scenario)) continue;
    const legacy = typeof mcpIsError !== 'boolean';
    const legacyError = ['ABSOLUTE_RANGE_REJECTED', 'MCP_QUERY_ERROR', 'MCP_ERROR_NO_PERIOD',
      'INVALID_RANGE_REJECTED'].includes(saved.reason);
    let current;
    if (!def || !args || typeof mcpText !== 'string' || (legacy && saved.status === 'UNVERIFIABLE')) {
      current = { id: saved.id, status: 'UNVERIFIABLE', reason: 'REPLAY_INPUT_MISSING',
        checks: [], evidence: {} };
    } else {
      if (!negative && typeof args.timeRange === 'string' && !args.timeRange.includes('/')) {
        scenario.fixed = undefined;
        scenario.timeRange = args.timeRange;
      }
      const callTool = async (_tool, actual) => {
        if (!isDeepStrictEqual(args, actual)) throw new Error('REPLAY_ARGUMENTS_DIFFER');
        return { isError: mcpIsError ?? legacyError, content: [{ type: 'text', text: mcpText }] };
      };
      const readResponse = response => async (_scenario, window) => {
        const payload = response?.request?.payload;
        if (!payload || payload.stime !== window.stime || payload.etime !== window.etime) {
          throw new Error('REPLAY_HTTP_WINDOW_DIFFER_OR_MISSING');
        }
        return response;
      };
      current = negative ? await invalidApmRange({ callTool }, scenario) :
        await probe({ callTool }, { mxql: readResponse(reference), stats: readResponse(referenceV2) }, scenario);
    }
    addProbe(run, saved.phase, current);
    run.replay.push({ phase: saved.phase, id: saved.id, legacyErrorFlagInferred: legacy,
      previous: [saved.status, saved.reason], current: [current.status, current.reason] });
  }
}

async function live(run, values) {
  const config = JSON.parse(await readFile(resolve(values.config), 'utf8'));
  if (values['fixed-end'] !== undefined) config.fixedEnd = Number(values['fixed-end']);
  if (![config.serverProject, config.apmProject].every(n => Number.isSafeInteger(n) && n > 0) ||
      (config.fixedEnd !== undefined && (!Number.isSafeInteger(config.fixedEnd) ||
        config.fixedEnd <= 900_000 || config.fixedEnd > Date.now() || config.fixedEnd % 300_000 !== 0))) {
    throw new Error('CONFIG_PROJECT_OR_WINDOW');
  }
  const cases = validationScenarios(config).filter(s => matches(values.select, s));
  run.conditions = { cases };
  if (!values.mcp) throw new Error('MCP_CHECKOUT_REQUIRED');
  const checkout = resolve(values.mcp);
  const entry = join(checkout, 'dist/index.js');
  run.target = { ...await gitInfo(checkout),
    artifactSha256: createHash('sha256').update(await readFile(entry)).digest('hex') };
  if (!process.env.WHATAP_API_TOKEN || !process.env.WHATAP_HTTP_API_TOKEN) {
    throw new Error('WHATAP_DEMO_TOKENS_MISSING');
  }
  const signal = AbortSignal.timeout(480_000);
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'WHATAP_API_TOKEN']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  api = new ReferenceApi(process.env.WHATAP_HTTP_API_TOKEN, config.apiOrigin, fetch, signal);
  env.WHATAP_API_URL = api.origin;
  const client = new StdioMcpClient(entry, 45_000, env, signal);
  try {
    const projects = [...new Set(cases.filter(s => !s.negative).map(s => s.projectCode))];
    if (projects.length) await api.connect(projects);
    await client.start();
    for (const scenario of cases) {
      signal.throwIfAborted();
      const result = scenario.negative ? await invalidApmRange(client, scenario) : await probe(client, api, scenario);
      addProbe(run, values.phase, result);
    }
    signal.throwIfAborted();
  } finally {
    await client.close();
  }
}

async function main(run) {
  const { values } = parseArgs({ options });
  if (values.select.some(id => !groups.includes(id) && !catalog.some(s => s.id === id))) {
    throw new Error('UNKNOWN_SCENARIO');
  }
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(values.phase)) throw new Error('INVALID_PHASE');
  run.request = values.request;
  run.mode = values.replay ? 'replay' : 'live';
  const harness = await gitInfo(root);
  run.harness = harness.commit;
  run.environment.harnessDirty = harness.dirty;
  if (values.replay) {
    if (values.mcp || values['fixed-end']) throw new Error('REPLAY_OPTION_CONFLICT');
    await replay(run, values);
  } else {
    await live(run, values);
  }
  if (!run.probes.length) throw new Error('NO_SCENARIO_RESULT');
  run.status = run.probes.some(p => p.status === 'FAIL') ? 'VALIDATION_FAILED' :
    run.probes.some(p => p.status !== 'PASS') ? 'UNVERIFIABLE' : 'VERIFIED';
}

if (process.argv.length === 3 && process.argv[2] === '--list') {
  for (const scenario of catalog) console.log(scenario.id, scenario.domain);
} else {
  await mkdir(join(root, 'runs'), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'runs', new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  const run = { id: basename(directory), baseline, status: 'UNVERIFIABLE', startedAt: new Date().toISOString(), events: [], probes: [],
    environment: { node: process.version, platform: process.platform, arch: process.arch } };
  await execute(run, directory);
}

async function execute(run, directory) {
  try {
    await main(run);
  } catch (error) {
    const detail = redact(String(error.cause?.code ?? error.message));
    const status = /TOKEN|HTTP_PROJECT|ENOTFOUND|EAI_AGAIN|ECONN/.test(detail) ?
      'ENVIRONMENT_OR_AUTH' : 'UNVERIFIABLE';
    runEvent(run, 'terminal', status, detail);
    run.status = run.probes.some(p => p.status === 'FAIL') ? 'VALIDATION_FAILED' : status;
  } finally {
    run.finishedAt = new Date().toISOString();
    await saveReport(directory, run, redact);
    console.log(run.status, join(directory, 'report.md'));
    for (const p of run.probes) console.log(p.status, p.id, p.reason);
    process.exitCode = run.status === 'VERIFIED' ? 0 : run.status === 'VALIDATION_FAILED' ? 1 : 2;
  }
}
