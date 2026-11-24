import { isDeepStrictEqual } from 'node:util';
import { compareApmV2 } from './apm.js';
import { checkSummary } from './summary.js';
import { parseFormattedMcp, parseMcpPeriod, expectedDurationMs, forMcpDisplay } from './period.js';
import { assessReference, compareRows } from './validator.js';

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

export async function probe(client, api, scenario) {
  const args = argumentsFor(scenario);
  const evidence = { args };
  const finish = (status, reason, checks = []) => ({
    id: scenario.id, status, reason, checks, evidence,
  });
  try {
    const candidate = await client.callTool(query, args);
    const markdown = textOf(candidate);
    evidence.mcpText = markdown;
    evidence.mcpIsError = candidate.isError === true;
    const period = parseMcpPeriod(markdown);
    evidence.mcpPeriod = period;

    // Absolute input supplies a fixed independent control even if MCP rejects it.
    // Relative input never produces an HTTP request without a valid returned Period.
    const window = scenario.fixed ?? period;
    if (!window) return finish('UNVERIFIABLE', candidate.isError ? 'MCP_ERROR_NO_PERIOD' : 'MCP_PERIOD_INVALID');
    evidence.reference = await api.mxql(scenario, window);
    const assessed = assessReference({ ...scenario, ...window }, evidence.reference);
    const checks = assessed.checks;
    const body = evidence.reference.body;
    const reportedError = body?.error || (assessed.rows ?? []).some(row => Object.hasOwn(row, 'error'));
    if (!assessed.complete || !assessed.rows.length || reportedError) {
      return finish('UNVERIFIABLE', 'HTTP_REFERENCE_INCOMPLETE', checks);
    }
    if (candidate.isError) {
      const explicitRangeError = /invalid time range format/i.test(markdown);
      return finish(scenario.fixed && explicitRangeError ? 'FAIL' : 'UNVERIFIABLE',
        scenario.fixed && explicitRangeError ? 'ABSOLUTE_RANGE_REJECTED' : 'MCP_QUERY_ERROR', checks);
    }
    if (!period) return finish('FAIL', 'MCP_PERIOD_INVALID', checks);
    if (scenario.fixed ? period.stime !== window.stime || period.etime !== window.etime
      : period.etime - period.stime !== expectedDurationMs(scenario.timeRange)) {
      return finish('FAIL', 'MCP_PERIOD_MISMATCH', checks);
    }

    const parsed = parseFormattedMcp(markdown, [...scenario.matchKeys, ...scenario.compareFields]);
    if (!parsed.ok) return finish('FAIL', parsed.reason, checks);
    evidence.mcpRows = parsed.data.rows;
    const rows = forMcpDisplay(assessed.rows, scenario.compareFields);
    // A limit notice can be conservative when the number of rows equals the limit.
    // Equal key sets and an independently complete reference are required in either case.
    checks.push({ code: 'MCP_DISPLAY_LIMIT', ok: true,
      detail: `MCP ${parsed.data.rows.length}행, HTTP ${rows.length}행, MCP 제한 안내 ${parsed.data.truncated}` });
    let comparable = rows;
    if (scenario.statisticsMode && rows.length > parsed.data.rows.length) {
      const key = row => JSON.stringify(scenario.matchKeys.map(field => String(row[field])));
      const visible = new Set(parsed.data.rows.map(key));
      if (!parsed.data.truncated || parsed.data.rows.length !== scenario.limit) {
        return finish('FAIL', 'APM_UNDISCLOSED_OR_PREMATURE_LIMIT', checks);
      }
      comparable = rows.filter(row => visible.has(key(row)));
    }
    const comparison = compareRows(scenario, comparable, parsed.data.rows);
    checks.push(...comparison.checks);
    if (comparison.status !== 'PASS') return finish(comparison.status, comparison.reason, checks);
    const summary = checkSummary(markdown, scenario, assessed.rows, parsed.data.rows);
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
      if (scenario.fixed) {
        evidence.referenceV2 = await api.stats(scenario, window);
        const full = compareApmV2(scenario, assessed.rows, evidence.referenceV2, window);
        checks.push(full.check);
        evidence.fullPeriodAggregates = full.aggregates;
        if (full.verdict !== 'PASS') return finish(full.verdict, full.reason, checks);
      }
    }

    return finish('PASS', comparable.length < rows.length ? 'DISCLOSED_SAMPLE_MATCH' : 'ROWS_AND_PERIOD_MATCH', checks);
  } catch (error) {
    evidence.error = String(error?.cause?.code ?? error?.message ?? 'unknown');
    return finish('UNVERIFIABLE', 'QUERY_UNAVAILABLE');
  }
}

export async function invalidApmRange(client, scenario) {
  const args = { ...argumentsFor(scenario), timeRange: 'invalid-range' };
  try {
    const candidate = await client.callTool(query, args);
    const mcpText = textOf(candidate);
    const rejected = candidate.isError === true && /invalid time range format/i.test(mcpText) && !parseMcpPeriod(mcpText);
    return { id: 'apm-invalid-range', status: rejected ? 'PASS' : 'FAIL',
      reason: rejected ? 'INVALID_RANGE_REJECTED' : 'INVALID_RANGE_ACCEPTED',
      checks: [], evidence: { args, mcpText, mcpIsError: candidate.isError === true } };
  } catch (error) {
    return { id: 'apm-invalid-range', status: 'UNVERIFIABLE', reason: 'QUERY_UNAVAILABLE',
      checks: [], evidence: { args, error: String(error.message) } };
  }
}
