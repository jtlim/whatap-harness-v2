import { isDeepStrictEqual } from 'node:util';
import { compareApmV2, FIVE_MIN } from './apm.js';
import { checkSummary } from './summary.js';
import { parseFormattedMcp, parseMcpPeriod, checkMcpWindow, periodPrecisionMs, forMcpDisplay } from './period.js';
import { assessReference, checkRowKeys, compareRows, indexRows, keyStatistics } from './validator.js';

export const query = 'whatap_query_data';

function isoInterval({ stime, etime }) {
  return [stime, etime].map(time => new Date(time).toISOString()).join('/');
}

export function argumentsFor(s) {
  return { projectCode: s.projectCode, path: s.path, limit: s.limit,
    timeRange: s.fixed ? isoInterval(s.fixed) : s.timeRange };
}

function textOf(result) {
  return result?.content?.filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n') ?? '';
}

function aggregate(rows, groupKeys, fields) {
  const totals = new Map();
  for (const row of rows) {
    const parts = groupKeys.map(key => row[key]);
    if (parts.some(value => value == null || value === '-' || value === '')) return null;
    const key = JSON.stringify(parts.map(String));
    const sums = totals.get(key) ?? {};
    for (const field of fields) {
      const value = row[field];
      if (!['number', 'string'].includes(typeof value) ||
          !/^-?\d+(?:\.\d+)?$/.test(String(value))) return null;
      // Sum in hundredths so rounding and sum order cannot affect the comparison.
      const units = Math.round(Number(value) * 100);
      const sum = (sums[field] ?? 0) + units;
      if (!Number.isSafeInteger(units) || !Number.isSafeInteger(sum) || units < 0) return null;
      sums[field] = sum;
    }
    totals.set(key, sums);
  }
  return totals;
}

function checkBoundaryOverlap(scenario, period, timing, reference, candidate) {
  // The seconds-only label can hide a subsecond shift. Require matching
  // interior rows and the exact exchange of identities at the two edges.
  if (scenario.fixed || periodPrecisionMs(period) !== 1000 || timing.finishedAt <= period.etime)
    return null;
  const inside = row => row.time > period.stime && row.time < period.etime;
  const httpInterior = reference.filter(inside);
  const mcpInterior = candidate.filter(inside);
  const httpEdge = reference.filter(row => row.time === period.stime);
  const mcpEdge = candidate.filter(row => row.time === period.etime);
  if (!httpInterior.length || !httpEdge.length || reference.length !== httpInterior.length + httpEdge.length ||
      candidate.length !== mcpInterior.length + mcpEdge.length) return null;
  const edgeKeys = rows => rows.map(row =>
    JSON.stringify(scenario.matchKeys.filter(key => key !== 'time').map(key => String(row[key])))).sort();
  const httpKeys = edgeKeys(httpEdge);
  const mcpKeys = edgeKeys(mcpEdge);
  // With a proven positive fractional shift, sparse series can lose an
  // initial sample without having a new sample at the far edge. Require a
  // matching start identity for every MCP-only end row.
  if (!isDeepStrictEqual(httpKeys, mcpKeys)) {
    if (timing.startedAt <= period.etime || !mcpKeys.length) return null;
    const remaining = [...httpKeys];
    for (const key of mcpKeys) {
      const index = remaining.indexOf(key);
      if (index < 0) return null;
      remaining.splice(index, 1);
    }
  }
  return compareRows(scenario, httpInterior, mcpInterior);
}

export async function probe(client, api, scenario, { now = Date.now, timing } = {}) {
  const args = argumentsFor(scenario);
  const evidence = { args };
  const finish = (status, reason, checks = []) => ({
    id: scenario.id, status, reason, checks, evidence,
  });
  const checks = [];
  let keyFailure;
  try {
    const startedAt = now();
    const candidate = await client.callTool(query, args);
    evidence.callTiming = timing === undefined ? { startedAt, finishedAt: now() } : timing;
    const markdown = textOf(candidate);
    evidence.mcpText = markdown;
    evidence.mcpIsError = candidate.isError === true;
    const period = parseMcpPeriod(markdown);
    evidence.mcpPeriod = period;

    const periodProblem = checkMcpWindow(scenario, period, evidence.callTiming);
    checks.push({ code: 'MCP_PERIOD', ok: !periodProblem,
      detail: periodProblem ?? '요청 기간 및 UTC 경계 확인' });
    const rejectedRange = candidate.isError && /invalid time range format/i.test(markdown);
    if (rejectedRange && !scenario.fixed) return finish('FAIL', 'SUPPORTED_RANGE_REJECTED', checks);

    let parsed;
    let mcpIndex;
    if (!candidate.isError && period) {
      parsed = parseFormattedMcp(markdown, [...scenario.matchKeys, ...scenario.compareFields]);
      if (!parsed.ok) return finish('FAIL', parsed.reason, checks);
      evidence.mcpRows = parsed.data.rows;
      mcpIndex = indexRows(parsed.data.rows, scenario.matchKeys);
      evidence.recordKeys = { mcp: keyStatistics(mcpIndex, scenario.compareFields), cause: 'UNCONFIRMED' };
      const displayed = parsed.data.rows.length;
      const withinLimit = displayed <= args.limit;
      checks.push({ code: 'MCP_DISPLAY_LIMIT', ok: withinLimit,
        detail: `요청 한도 ${args.limit}행, MCP 표시 ${displayed}행, 제한 안내 ${parsed.data.truncated}` });
      if (!withinLimit) return finish('FAIL', 'MCP_DISPLAY_LIMIT_EXCEEDED', checks);
      const local = checkRowKeys(null, mcpIndex);
      if (local.status === 'FAIL') keyFailure = local;
    }

    if (!candidate.isError && periodProblem) {
      if (keyFailure) return finish('FAIL', keyFailure.reason, [...checks, keyFailure.check]);
      if ((!period && /no rows returned|no data/i.test(markdown) && !/\*\*Period\*\*/i.test(markdown)) ||
          periodProblem === 'MCP_CALL_TIMING_UNAVAILABLE') {
        return finish('UNVERIFIABLE', period ? periodProblem : 'MCP_NO_DATA_NO_PERIOD', checks);
      }
      return finish('FAIL', periodProblem, checks);
    }
    const window = scenario.fixed ?? period;
    if (!window || (!scenario.fixed && periodProblem)) return finish('UNVERIFIABLE', 'MCP_ERROR_NO_PERIOD', checks);
    evidence.reference = await api.mxql(scenario, window);
    if (!evidence.reference) throw new Error('HTTP_REFERENCE_UNAVAILABLE');
    const assessed = assessReference({ ...scenario, ...window }, evidence.reference);
    checks.push(...assessed.checks);
    if (mcpIndex) {
      // Audit full HTTP identities before selecting a display prefix.
      const httpIndex = assessed.rows && indexRows(assessed.rows, scenario.matchKeys);
      if (httpIndex) {
        evidence.recordKeys.http = keyStatistics(httpIndex, scenario.compareFields);
        evidence.recordKeys.sharedDuplicateKeys = [...mcpIndex.map].filter(([key, group]) =>
          group.length > 1 && (httpIndex.map.get(key)?.length ?? 0) > 1).length;
      }
      const identity = checkRowKeys(httpIndex, mcpIndex);
      if (identity.status !== 'PASS') return finish(identity.status, identity.reason, [...checks, identity.check]);
    }
    const body = evidence.reference?.body;
    const reportedError = body?.error || (assessed.rows ?? []).some(row => Object.hasOwn(row, 'error'));
    if (!assessed.complete || !assessed.rows.length || reportedError) {
      return finish('UNVERIFIABLE', 'HTTP_REFERENCE_INCOMPLETE', checks);
    }
    if (candidate.isError) {
      if (/authentication failed|no api token found|rate limit|request timed out|too many requests/i.test(markdown))
        return finish('UNVERIFIABLE', 'MCP_UPSTREAM_UNAVAILABLE', checks);
      return finish('FAIL', rejectedRange ? 'ABSOLUTE_RANGE_REJECTED' : 'MCP_QUERY_ERROR', checks);
    }

    const rows = forMcpDisplay(assessed.rows, scenario.compareFields);
    let comparable = rows;
    if (scenario.path === 'v2/sys/server_base' && rows.length > parsed.data.rows.length &&
        parsed.data.truncated && parsed.data.rows.length === args.limit) {
      // The server query displays the leading rows from its API response.
      // A provable positive fractional shift excludes rows at the floored
      // start label from that prefix.
      const source = !scenario.fixed && periodPrecisionMs(period) === 1000 &&
        evidence.callTiming.startedAt > period.etime ? rows.filter(row => row.time !== period.stime) : rows;
      comparable = source.slice(0, args.limit);
      checks.push({ code: 'SERVER_DISPLAY_PREFIX', ok: true,
        detail: `HTTP 원본 ${rows.length}행 중 비교할 선두 ${comparable.length}행 선택` });
    } else if (scenario.statisticsMode && rows.length > parsed.data.rows.length) {
      if (!parsed.data.truncated || parsed.data.rows.length !== scenario.limit) {
        return finish('FAIL', 'APM_UNDISCLOSED_OR_PREMATURE_LIMIT', checks);
      }
      comparable = rows.slice(0, args.limit);
    }
    const rowIndices = new Map(rows.map((row, index) => [row, index]));
    evidence.comparedHttpIndices = comparable.map(row => rowIndices.get(row));
    const comparison = compareRows(scenario, comparable, parsed.data.rows);
    evidence.recordComparison = comparison.comparison;
    checks.push(...comparison.checks);
    if (comparison.reason === 'MISSING_OR_EXTRA_RECORDS' && comparable === rows) {
      const overlap = checkBoundaryOverlap(scenario, period, evidence.callTiming, comparable, parsed.data.rows);
      if (overlap?.status === 'PASS') {
        checks.push({ code: 'MCP_PERIOD_PRECISION', ok: false,
          detail: '초 단위 Period의 경계 행이 교체되어 전체 범위의 일치를 확인할 수 없습니다.' });
        return finish('UNVERIFIABLE', 'MCP_PERIOD_PRECISION_LIMIT', checks);
      }
      if (overlap?.reason === 'FIELD_MISMATCH') return finish('FAIL', overlap.reason, [...checks, ...overlap.checks]);
    }
    if (comparison.status !== 'PASS') return finish(comparison.status, comparison.reason, checks);
    const summary = checkSummary(markdown, evidence.comparedHttpIndices.map(i => assessed.rows[i]), parsed.data.rows);
    checks.push(summary);
    if (!summary.ok) return finish('FAIL', 'MCP_SUMMARY_MISMATCH', checks);

    if (scenario.statisticsMode) {
      const reference = aggregate(comparable, scenario.groupKeys, scenario.compareFields);
      const mcp = aggregate(parsed.data.rows, scenario.groupKeys, scenario.compareFields);
      evidence.aggregatesInHundredths = { reference: reference && [...reference], mcp: mcp && [...mcp] };
      if (!reference || !mcp) return finish('UNVERIFIABLE', 'APM_AGGREGATES_INVALID', checks);
      const ok = isDeepStrictEqual(reference, mcp);
      checks.push({ code: 'APM_GROUP_AGGREGATES', ok, detail: `동일 식별자 표시 행 기준 그룹 ${reference.size}개 합계 대조` });
      if (!ok) return finish('FAIL', 'APM_AGGREGATES_DIFFER', checks);
      if (scenario.fixed || scenario.crossCheckStats) {
        // v2 accepts complete five-minute buckets. Use only buckets fully
        // contained in the verified Period for this additional reference check.
        const statsWindow = scenario.fixed ?? {
          stime: Math.ceil(window.stime / FIVE_MIN) * FIVE_MIN,
          etime: Math.floor(window.etime / FIVE_MIN) * FIVE_MIN,
        };
        evidence.statsWindow = statsWindow;
        if (statsWindow.etime <= statsWindow.stime)
          return finish('UNVERIFIABLE', 'APM_NO_COMPLETE_BUCKET_WINDOW', checks);
        evidence.referenceV2 = await api.stats(scenario, statsWindow);
        const full = compareApmV2(scenario, assessed.rows, evidence.referenceV2, statsWindow);
        checks.push(full.check);
        evidence.fullPeriodAggregates = full.aggregates;
        if (full.verdict !== 'PASS') return finish(full.verdict, full.reason, checks);
      }
    }

    return finish('PASS', comparable.length < rows.length ? 'DISCLOSED_SAMPLE_MATCH' : 'ROWS_AND_PERIOD_MATCH', checks);
  } catch (error) {
    evidence.error = String(error?.cause?.code ?? error?.message ?? 'unknown');
    if (keyFailure) return finish('FAIL', keyFailure.reason, [...checks, keyFailure.check]);
    return finish('UNVERIFIABLE', 'QUERY_UNAVAILABLE', checks);
  }
}

export async function invalidApmRange(client, scenario) {
  const args = { ...argumentsFor(scenario), timeRange: scenario.invalidTimeRange ?? 'invalid-range' };
  try {
    const candidate = await client.callTool(query, args);
    const mcpText = textOf(candidate);
    const rejected = candidate.isError === true && /invalid time range format/i.test(mcpText) && !parseMcpPeriod(mcpText);
    return { id: scenario.negative ? scenario.id : 'apm-invalid-range', status: rejected ? 'PASS' : 'FAIL',
      reason: rejected ? 'INVALID_RANGE_REJECTED' : 'INVALID_RANGE_ACCEPTED',
      checks: [], evidence: { args, mcpText, mcpIsError: candidate.isError === true } };
  } catch (error) {
    return { id: scenario.negative ? scenario.id : 'apm-invalid-range', status: 'UNVERIFIABLE', reason: 'QUERY_UNAVAILABLE',
      checks: [], evidence: { args, error: String(error.message) } };
  }
}
