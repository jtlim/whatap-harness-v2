import { equivalentValues, keyOf, assessReference } from './validator.js';
import { forMcpDisplay, parseFormattedMcp } from './period.js';

function index(rows, keys) {
  const records = new Map();
  let duplicates = 0, missingKeys = 0;
  for (const row of rows) {
    const key = keyOf(row, keys);
    if (key === null) { missingKeys++; continue; }
    if (records.has(key)) {
      duplicates++;
      records.set(key, null);
    } else records.set(key, row);
  }
  return { records, duplicates, missingKeys };
}

function numeric(value) {
  if (typeof value === 'string' && !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function comparisonEvidence(probe, scenario, acceptsSample = () => true) {
  const e = probe.evidence ?? {};
  const window = scenario?.fixed ?? e.mcpPeriod;
  const fields = scenario?.compareFields ?? [];
  const keys = scenario?.matchKeys ?? [];
  const http = e.reference && window ? assessReference({ ...scenario, ...window }, e.reference) : null;
  const parsed = fields.length && keys.length && e.mcpIsError !== true
    ? parseFormattedMcp(e.mcpText ?? '', [...keys, ...fields]) : null;
  const mcp = e.mcpRows ?? (parsed?.ok ? parsed.data.rows : null);
  const raw = http?.rows;
  const stats = {
    keys, fields, absoluteTolerance: scenario?.absoluteTolerance ?? 0,
    requestWindow: window ? { stime: window.stime, etime: window.etime } : null,
    mcpRows: mcp?.length ?? null, httpRows: raw?.length ?? null,
    mcpLimit: e.args?.limit ?? null, limitNotice: parsed?.ok ? parsed.data.truncated : null,
    coverage: probe.reason === 'DISCLOSED_SAMPLE_MATCH' ? 'DISPLAYED_SAMPLE' :
      probe.status === 'PASS' && mcp && raw ? 'FULL_ROWS' : 'NOT_ESTABLISHED',
    verdictComparedFields: probe.checks?.some(c => c.code === 'FIELD_VALUES') ?? false,
    comparisonUnavailable: null, samples: [], fieldErrors: {},
  };
  if (scenario?.expectedStepMs && window) {
    const step = scenario.expectedStepMs;
    stats.series = {
      expectedStartLabels: Math.max(0, Math.floor((window.etime - 1) / step) - Math.ceil(window.stime / step) + 1),
      expectedEndLabels: Math.max(0, Math.floor(window.etime / step) - Math.floor(window.stime / step)),
      httpUniqueTimes: raw ? new Set(raw.map(row => row.time).filter(Number.isFinite)).size : null,
      mcpUniqueTimes: mcp ? new Set(mcp.map(row => row.time).filter(Number.isFinite)).size : null,
    };
  }
  if (!mcp || !raw || !keys.length || !fields.length) {
    stats.comparisonUnavailable = probe.reason ?? 'EVIDENCE_MISSING';
    if (raw && keys.length && fields.length) {
      for (const [i, row] of raw.entries()) {
        for (let j = 0; j < fields.length; j++) {
          const field = fields[(i + j) % fields.length];
          const sample = { time: row.time, key: keyOf(row, keys), field, http: row[field],
            status: 'HTTP_REFERENCE_ONLY' };
          if (acceptsSample(sample)) {
            stats.samples.push(sample);
            break;
          }
        }
        if (stats.samples.length === 5) break;
      }
    }
    return stats;
  }
  const verdict = e.recordComparison;
  let a = index(raw, keys), b = index(mcp, keys);
  const display = forMcpDisplay(raw, fields);
  let normalized = new Map(display.map(row => [keyOf(row, keys), row]));
  stats.identities = {
    httpMissingKeys: a.missingKeys, mcpMissingKeys: b.missingKeys,
    httpDuplicateRows: a.duplicates, mcpDuplicateRows: b.duplicates,
    httpOnly: [...a.records.keys()].filter(k => !b.records.has(k)).length,
    mcpOnly: [...b.records.keys()].filter(k => !a.records.has(k)).length,
  };
  if (verdict && e.comparedHttpIndices) {
    const httpRows = e.comparedHttpIndices.map(i => raw[i]);
    const httpRecords = new Map(httpRows.map((row, i) => [i, row]));
    const mcpRecords = new Map(mcp.map((row, i) => ['unmatched-' + i, row]));
    for (const [i, j] of verdict.pairs) {
      mcpRecords.delete('unmatched-' + j);
      mcpRecords.set(i, mcp[j]);
    }
    a = { records: httpRecords };
    b = { records: mcpRecords };
    normalized = new Map(e.comparedHttpIndices.map((i, j) => [j, display[i]]));
    stats.identities.httpOnly = verdict.httpOnly;
    stats.identities.mcpOnly = verdict.mcpOnly;
    stats.unpairedHttpRows = httpRows.length - verdict.pairs.length;
    stats.unpairedMcpRows = mcp.length - verdict.pairs.length;
  }
  stats.matchedRows = 0;
  stats.mismatchedRows = 0;
  const matches = [], differences = [];
  const matchesByField = new Map(fields.map(field => [field, []]));
  const add = (list, entry) => { if (list.length < 5 && acceptsSample(entry)) list.push(entry); };
  const oneSided = (_key, row, side, status) => {
    const key = keyOf(row, keys);
    const entry = fields.map(field => ({ time: row.time, key, field, [side]: row[field], status }))
      .find(acceptsSample);
    if (entry) add(differences, entry);
  };
  for (const [key, row] of a.records) {
    const other = b.records.get(key);
    if (!row || !other) {
      if (row && !b.records.has(key) && (verdict || stats.coverage !== 'DISPLAYED_SAMPLE'))
        oneSided(key, row, 'http', verdict ? 'HTTP_UNPAIRED' : 'HTTP_ONLY');
      continue;
    }
    let equal = true;
    for (const field of fields) {
      const expected = normalized.get(key)[field], actual = other[field];
      const hasHttp = Object.hasOwn(row, field), hasMcp = Object.hasOwn(other, field);
      const ok = hasHttp && hasMcp && equivalentValues(expected, actual, stats.absoluteTolerance);
      equal &&= ok;
      const x = numeric(row[field]), y = numeric(actual), z = numeric(expected);
      const rawDifference = x === null || y === null ? null : y - x;
      const normalizedDifference = z === null || y === null ? null : y - z;
      const fieldStats = stats.fieldErrors[field] ??= { numericPairs: 0, mismatches: 0,
        missingHttp: 0, missingMcp: 0, maxRawAbsoluteError: null, maxNormalizedAbsoluteError: null };
      fieldStats.mismatches += Number(!ok);
      fieldStats.missingHttp += Number(!hasHttp);
      fieldStats.missingMcp += Number(!hasMcp);
      if (rawDifference !== null && normalizedDifference !== null) {
        fieldStats.numericPairs++;
        fieldStats.maxRawAbsoluteError = Math.max(fieldStats.maxRawAbsoluteError ?? 0, Math.abs(rawDifference));
        fieldStats.maxNormalizedAbsoluteError = Math.max(fieldStats.maxNormalizedAbsoluteError ?? 0, Math.abs(normalizedDifference));
      }
      add(ok ? matchesByField.get(field) : differences, { time: row.time, key: keyOf(row, keys), field, mcp: actual, http: row[field],
        expectedDisplay: expected, rawDifference, normalizedDifference, status: ok ? 'MATCH' : 'DIFFER' });
    }
    if (equal) stats.matchedRows++;
    else stats.mismatchedRows++;
  }
  for (const [key, row] of b.records) {
    if (row && !a.records.has(key))
      oneSided(key, row, 'mcp', verdict ? 'MCP_UNPAIRED' : 'MCP_ONLY');
  }
  stats.comparedRows = stats.matchedRows + stats.mismatchedRows;
  for (let i = 0; i < 5; i++) {
    for (const examples of matchesByField.values()) {
      if (examples[i]) add(matches, examples[i]);
    }
  }
  stats.samples = [...differences, ...matches].slice(0, 5);
  return stats;
}

export function scenarioForProbe(run, probe) {
  const scenario = run.conditions?.cases?.find(s => s.id === probe.id);
  return scenario && !probe.evidence?.args?.timeRange?.includes('/')
    ? { ...scenario, fixed: undefined } : scenario;
}

export function withComparisonEvidence(run) {
  return { ...run, probes: run.probes.map(p => ({
    ...p, comparison: comparisonEvidence(p, scenarioForProbe(run, p)),
  })) };
}
