import { isDeepStrictEqual } from 'node:util';
import { forMcpDisplay, parseFormattedMcp } from './period.js';
import { argumentsFor, probe, query } from './probe.js';
import { assessReference } from './validator.js';

export const id = 'server-cpu-ai';
const step = 5000;
const sampleCount = 12;
const fields = { metric: 'cpu', unit: '%' };

export function cpuScenario(projectCode, serverId, etime) {
  if (!Number.isSafeInteger(projectCode) || projectCode <= 0 || !/^-?\d+$/.test(serverId ?? '') ||
      !Number.isSafeInteger(etime) || etime <= 60_000 || etime > Date.now() || etime % step !== 0) {
    throw Error('INVALID_CPU_ANSWER_WINDOW_OR_TARGET');
  }
  return {
    id, domain: 'server', projectCode, serverId, path: 'v2/sys/server_base',
    fixed: { stime: etime - step * sampleCount, etime },
    matchKeys: ['time', '_id_'], compareFields: ['cpu'], limit: 1000,
  };
}

function conditions(scenario) {
  return {
    projectCode: scenario.projectCode, serverId: scenario.serverId, ...fields,
    startUtc: new Date(scenario.fixed.stime).toISOString(),
    endUtc: new Date(scenario.fixed.etime).toISOString(),
  };
}

export function cpuQuestion(scenario) {
  const { projectCode, serverId, startUtc, endUtc } = conditions(scenario);
  return `프로젝트 ${projectCode}, 서버 ${serverId}의 ${startUtc} 이상 ${endUtc} 미만 구간에서 MCP 표의 cpu(%)를 조회해 표본 수, 산술 평균과 최대값을 알려줘. 해당 서버의 표시 행만 사용하고 평균과 최대는 소수 둘째 자리까지 반올림해. 최종 답변은 projectCode, serverId(문자열), metric("cpu"), unit("%"), startUtc, endUtc, sampleCount, averageCpu, maxCpu가 포함된 JSON 객체 하나로 작성해.`;
}

export const mcpCall = scenario => ({ name: query, args: argumentsFor(scenario) });
const resultText = result => result?.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') ?? '';

export function cpuInput(scenario, result) {
  const parsed = parseFormattedMcp(resultText(result), scenario.matchKeys.concat('cpu'));
  return {
    period: parsed.ok ? parsed.data.period.label : null,
    rows: parsed.ok ? parsed.data.rows.filter(row => String(row._id_) === scenario.serverId)
      .map(({ time, cpu }) => ({ time, cpu })) : [],
    error: result?.isError || !parsed.ok ? 'MCP_CPU_INPUT_UNAVAILABLE' : null,
  };
}

function summarize(rows) {
  const values = rows.map(row => row.cpu);
  return { sampleCount: rows.length, averageCpu: values.reduce((sum, cpu) => sum + cpu, 0) / rows.length,
    maxCpu: Math.max(...values) };
}

function referenceCpu(scenario, reference) {
  const assessed = assessReference({ ...scenario, ...scenario.fixed }, reference);
  const rows = (assessed.rows ?? []).filter(row => String(row._id_) === scenario.serverId)
    .sort((a, b) => a.time - b.time);
  const complete = assessed.complete && !reference.body?.error && !assessed.rows.some(r => r.error) &&
    assessed.rows.every(r => r._id_ != null && Number.isSafeInteger(r.time)) && rows.length === sampleCount &&
    rows.every((row, index) => row.time === scenario.fixed.stime + index * step &&
      Number.isFinite(row.cpu) && row.cpu >= 0 && row.cpu <= 100);
  return complete ? { raw: summarize(rows), displayed: summarize(forMcpDisplay(rows, ['cpu'])) } : null;
}

export async function verifyCpuAnswer(scenario, capture, submission, reference) {
  const callMatches = isDeepStrictEqual(capture.call, mcpCall(scenario));
  const expected = referenceCpu(scenario, reference);
  const mcp = !callMatches
    ? { id, status: 'FAIL', reason: 'MCP_CALL_MISMATCH', checks: [], evidence: {} }
    : await probe({ callTool: () => capture.result }, { mxql: () => reference }, scenario);
  if (!expected && callMatches) {
    mcp.status = 'UNVERIFIABLE';
    mcp.reason = 'CPU_REFERENCE_INCOMPLETE';
  }
  let status = 'FAIL';
  let reason = 'AI_ANSWER_FORMAT';
  const checks = [];
  let answer;
  if (submission.failed) {
    status = 'AI_FAILED';
    reason = 'AI_EXECUTION_FAILED';
  } else {
    try { answer = JSON.parse(submission.text); } catch { /* malformed input */ }
    const target = conditions(scenario);
    const measures = ['sampleCount', 'averageCpu', 'maxCpu'];
    if (answer && typeof answer === 'object' && !Array.isArray(answer) &&
        Object.keys(answer).length === Object.keys(target).length + measures.length &&
        [...Object.keys(target), ...measures].every(key => Object.hasOwn(answer, key)) &&
        typeof answer.projectCode === 'number' &&
        Object.keys(target).filter(key => key !== 'projectCode').every(key => typeof answer[key] === 'string') &&
        measures.every(key => Number.isFinite(answer[key])) && Number.isSafeInteger(answer.sampleCount)) {
      for (const [key, value] of Object.entries(target)) {
        checks.push({ field: key, ok: answer[key] === value });
      }
      if (!callMatches || checks.some(check => !check.ok)) {
        reason = 'AI_QUERY_CONDITIONS_MISMATCH';
      } else if (!expected) {
        status = 'UNVERIFIABLE';
        reason = 'CPU_REFERENCE_INCOMPLETE';
      } else {
        for (const key of measures) {
          const raw = expected.raw[key];
          const displayed = Number(expected.displayed[key].toFixed(2));
          const delta = answer[key] - raw;
          checks.push({ field: key, expected: displayed, delta,
            ok: answer[key] === displayed && Math.abs(delta) <= (key === 'sampleCount' ? 0 : 0.010000001) });
        }
        status = checks.every(check => check.ok) ? 'PASS' : 'FAIL';
        reason = status === 'PASS' ? 'AI_CPU_ANSWER_MATCH' : 'AI_CPU_ANSWER_MISMATCH';
      }
    }
  }
  return { mcp, ai: { status, reason, checks, submission, independent: expected,
    responsibility: !callMatches ? 'MCP_CALL' : mcp.status === 'FAIL' && status === 'FAIL' ? 'MCP_AND_AI' :
      mcp.status === 'FAIL' ? 'MCP' : mcp.status === 'PASS' && status === 'FAIL' ? 'AI' :
      status === 'AI_FAILED' ? 'AI_EXECUTION' : mcp.status === 'PASS' && status === 'PASS' ? 'NONE' : 'UNDETERMINED' } };
}
