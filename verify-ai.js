import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cpuInput, cpuQuestion, cpuScenario, mcpCall, verifyCpuAnswer } from './lib/ai-answer.js';
import { ReferenceApi } from './lib/http.js';
import { StdioMcpClient } from './lib/mcp.js';
import { command } from './lib/process.js';
import { saveReport } from './lib/report.js';
import { baseline } from './lib/scenarios.js';

process.umask(0o077);
const root = dirname(fileURLToPath(import.meta.url));
const tokens = ['WHATAP_API_TOKEN', 'WHATAP_HTTP_API_TOKEN', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']
  .map(key => process.env[key]).filter(Boolean);
const redact = text => tokens.reduce((safe, token) => safe.replaceAll(token, '[REDACTED]'), text);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) => writeFile(path, redact(JSON.stringify(value, null, 2)) + '\n', { flag: 'wx' });

async function gitHead(cwd) {
  const result = await command('git', ['rev-parse', 'HEAD'], { cwd });
  if (result.code !== 0) throw Error('GIT_HEAD_UNAVAILABLE');
  return result.stdout.trim();
}

async function capture(values) {
  if (!values.mcp) throw Error('MCP_CHECKOUT_REQUIRED');
  const { serverProject, apiOrigin } = await readJson(values.config);
  const scenario = cpuScenario(serverProject, values.server, Number(values['end-ms']));
  const origin = new ReferenceApi(undefined, apiOrigin).origin;
  const token = process.env.WHATAP_API_TOKEN;
  if (!token) throw Error('WHATAP_API_TOKEN_MISSING');
  const checkout = resolve(values.mcp);
  const entry = join(checkout, 'dist/index.js');
  const target = { commit: await gitHead(checkout), artifactSha256: createHash('sha256').update(await readFile(entry)).digest('hex') };
  const call = mcpCall(scenario);
  const client = new StdioMcpClient(entry, 45_000, { PATH: process.env.PATH, WHATAP_API_TOKEN: token, WHATAP_API_URL: origin },
    AbortSignal.timeout(480_000));
  let result;
  try {
    await client.start();
    result = await client.callTool(call.name, call.args);
  } finally {
    await client.close();
  }
  await mkdir(join(root, 'runs'), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'runs', 'ai-cpu-'));
  const question = cpuQuestion(scenario);
  await writeJson(join(directory, 'capture.json'), { startedAt: new Date().toISOString(), scenario, question, call, result, origin, target });
  // Only the selected server's displayed CPU rows are supplied to the answering agent.
  console.log(redact(JSON.stringify({ directory, question, ...cpuInput(scenario, result) }, null, 2)));
}

async function verify(values) {
  if (!values.capture || Boolean(values.answer) === Boolean(values['ai-failed'])) throw Error('AI_ANSWER_INPUT_REQUIRED');
  const directory = resolve(values.capture);
  const capture = await readJson(join(directory, 'capture.json'));
  const scenario = cpuScenario(capture.scenario.projectCode, capture.scenario.serverId, capture.scenario.fixed.etime);
  const token = process.env.WHATAP_HTTP_API_TOKEN;
  if (!token) throw Error('WHATAP_HTTP_API_TOKEN_MISSING');
  const submission = values['ai-failed'] ? { failed: true } : { text: await readFile(values.answer, 'utf8') };
  // Seal the submitted response before making an independent HTTP request.
  await writeJson(join(directory, 'submission.json'), submission);
  const api = new ReferenceApi(token, capture.origin, fetch, AbortSignal.timeout(480_000));
  const events = [];
  let reference;
  try {
    await api.connect([scenario.projectCode]);
    reference = await api.mxql(scenario, scenario.fixed);
  } catch (error) {
    const code = error.cause?.code ?? error.message;
    events.push({ stage: 'http-reference', status: 'ENVIRONMENT_OR_AUTH', detail: /^[A-Z_0-9]+$/.test(code) ? code : 'HTTP_REFERENCE_UNAVAILABLE' });
  }
  const { mcp, ai } = await verifyCpuAnswer(scenario, capture, submission, reference);
  const status = mcp.status === 'FAIL' || ai.status === 'FAIL' ? 'VALIDATION_FAILED' :
    ai.status === 'AI_FAILED' ? 'AI_FAILED' :
      mcp.status === 'PASS' && ai.status === 'PASS' ? 'VERIFIED' : 'UNVERIFIABLE';
  await saveReport(directory, {
    id: basename(directory), baseline, harness: await gitHead(root), mode: 'ai-answer',
    status, target: capture.target, request: capture.question, startedAt: capture.startedAt,
    finishedAt: new Date().toISOString(), events, conditions: { cases: [scenario] },
    probes: [{ ...mcp, phase: 'audit' }], aiAnswer: { ...ai, call: capture.call },
  }, text => api.redact(redact(text)));
  console.log('MCP', mcp.status, mcp.reason, '| AI', ai.status, ai.reason, '|', join(directory, 'report.md'));
  process.exitCode = status === 'VERIFIED' ? 0 : status === 'UNVERIFIABLE' ? 2 : 1;
}

try {
  const [action, ...args] = process.argv.slice(2);
  const { values } = parseArgs({ args, options: {
    config: { type: 'string', default: join(root, 'config.local.json') },
    mcp: { type: 'string' }, server: { type: 'string' }, 'end-ms': { type: 'string' },
    capture: { type: 'string' }, answer: { type: 'string' }, 'ai-failed': { type: 'boolean' },
  } });
  if (action === 'capture') await capture(values);
  else if (action === 'verify') await verify(values);
  else throw Error('USAGE: node verify-ai.js capture|verify [options]');
} catch (error) {
  // Do not print paths, credentials, or subprocess diagnostics from unexpected errors.
  const message = error.message;
  console.error(/^[A-Z_0-9]+$/.test(message) ? message : 'AI_ANSWER_RUN_UNAVAILABLE');
  process.exitCode = 2;
}
