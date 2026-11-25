import { isDeepStrictEqual } from 'node:util';
import { checkMcpWindow, forMcpDisplay, parseFormattedMcp, parseMcpPeriod } from './period.js';
import { argumentsFor, probe, query } from './probe.js';
import { assessReference } from './validator.js';

export const id = 'server-cpu-ai';
const step = 5000;
const sampleCount = 12;
const fields = { metric: 'cpu', unit: '%' };

export function cpuScenario(projectCode, serverId, etime) {
  if (!Number.isSafeInteger(projectCode) || projectCode <= 0 || !/^-?\d+$/.test(serverId ?? '') ||
      (etime !== undefined && (!Number.isSafeInteger(etime) || etime <= 60_000 || etime > Date.now() || etime % step !== 0))) {
    throw Error('INVALID_CPU_ANSWER_WINDOW_OR_TARGET');
  }
  return {
    id, domain: 'server', projectCode, serverId, path: 'v2/sys/server_base',
    ...(etime === undefined ? { timeRange: '1m' } : { fixed: { stime: etime - step * sampleCount, etime } }),
    matchKeys: ['time', '_id_'], compareFields: ['cpu'], limit: 1000,
  };
}

function conditions(scenario, window) {
  return {
    projectCode: scenario.projectCode, serverId: scenario.serverId, ...fields,
    startUtc: new Date(window.stime).toISOString(),
    endUtc: new Date(window.etime).toISOString(),
  };
}

export function cpuQuestion(scenario) {
  const { projectCode, serverId } = scenario;
  const scope = scenario.fixed
    ? `${new Date(scenario.fixed.stime).toISOString()} 이상 ${new Date(scenario.fixed.etime).toISOString()} 미만 구간`
    : '요청 시점 기준 최근 1분(캡처에 표시된 Period의 시작 이상, 종료 미만)';
  return `프로젝트 ${projectCode}, 서버 ${serverId}의 ${scope}에서 MCP 표의 cpu(%)를 조회해 표본 수, 산술 평균과 최대값을 알려줘. 해당 서버의 표시 행을 모두 사용해. 같은 시각의 복수 행도 각각 표본에 포함하고 평균과 최대는 소수 둘째 자리까지 반올림해. startUtc와 endUtc에는 MCP Period를 UTC ISO 8601 YYYY-MM-DDTHH:mm:ss.sssZ 형식으로 옮겨 적고, 초 단위 Period에는 .000Z를 사용해. 최종 답변은 projectCode, serverId(문자열), metric("cpu"), unit("%"), startUtc, endUtc, sampleCount, averageCpu, maxCpu가 포함된 JSON 객체 하나로 작성해.`;

}

export const mcpCall = scenario => ({ name: query, args: argumentsFor(scenario) });
const resultText = result => result?.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') ?? '';

export function cpuWindow(scenario, capture) {
  if (capture.result?.isError || !isDeepStrictEqual(capture.call, mcpCall(scenario))) return null;
  const period = parseMcpPeriod(resultText(capture.result));
  return checkMcpWindow(scenario, period, capture.callTiming) ? null : period;
}

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

function referenceCpu(scenario, window, reference, indices) {
  if (!window) return null;
  const assessed = assessReference({ ...scenario, ...window }, reference);
  const source = indices && assessed.rows ? indices.map(i => assessed.rows[i]) : assessed.rows;
  const rows = (source ?? []).filter(row => String(row._id_) === scenario.serverId)
    .sort((a, b) => a.time - b.time);
  const times = [...new Set(rows.map(row => row.time))];
  const complete = assessed.complete && !reference.body?.error && !assessed.rows.some(r => r.error) &&
    assessed.rows.every(r => r._id_ != null && Number.isSafeInteger(r.time)) && times.length === sampleCount &&
    times.every((time, index) => time === times[0] + index * step) &&
    rows.every(row => Number.isFinite(row.cpu) && row.cpu >= 0 && row.cpu <= 100);
  return complete ? { raw: summarize(rows), displayed: summarize(forMcpDisplay(rows, ['cpu'])) } : null;
}

export async function verifyCpuAnswer(scenario, capture, submission, reference) {
  const callMatches = isDeepStrictEqual(capture.call, mcpCall(scenario));
  const window = cpuWindow(scenario, capture);
  const mcp = !callMatches
    ? { id, status: 'FAIL', reason: 'MCP_CALL_MISMATCH', checks: [], evidence: {} }
    : await probe({ callTool: () => capture.result }, { mxql: () => reference }, scenario, { timing: capture.callTiming ?? null });
  let expected = referenceCpu(scenario, window, reference, mcp.evidence.comparedHttpIndices);
  if (mcp.reason === 'MCP_PERIOD_PRECISION_LIMIT') {
    const selectedTimes = rows => rows.filter(row => String(row._id_) === scenario.serverId)
      .map(row => row.time).sort((a, b) => a - b);
    const raw = reference?.body?.data ?? reference?.body ?? [];
    if (!isDeepStrictEqual(selectedTimes(raw), selectedTimes(mcp.evidence.mcpRows))) expected = null;
  }
  else if (!expected && window &&
      !['MCP_DISPLAY_LIMIT_EXCEEDED', 'MCP_RECORD_IDENTITIES_INVALID', 'FIELD_MISMATCH'].includes(mcp.reason)) {
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
    const target = conditions(scenario, window ?? { stime: 0, etime: 0 });
    const measures = ['sampleCount', 'averageCpu', 'maxCpu'];
    if (answer && typeof answer === 'object' && !Array.isArray(answer) &&
        Object.keys(answer).length === Object.keys(target).length + measures.length &&
        [...Object.keys(target), ...measures].every(key => Object.hasOwn(answer, key)) &&
        typeof answer.projectCode === 'number' &&
        Object.keys(target).filter(key => key !== 'projectCode').every(key => typeof answer[key] === 'string') &&
        measures.every(key => Number.isFinite(answer[key])) && Number.isSafeInteger(answer.sampleCount)) {
      for (const [key, value] of Object.entries(target)) {
        checks.push({ field: key, ok: !window && (key === 'startUtc' || key === 'endUtc') ? null : answer[key] === value });
      }
      if (!callMatches || checks.some(check => check.ok === false)) {
        reason = 'AI_QUERY_CONDITIONS_MISMATCH';
      } else if (!expected) {
        status = 'UNVERIFIABLE';
        reason = mcp.reason === 'MCP_PERIOD_PRECISION_LIMIT' ? mcp.reason : 'CPU_REFERENCE_INCOMPLETE';
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
