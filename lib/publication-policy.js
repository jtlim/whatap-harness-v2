import { createHmac, randomBytes } from 'node:crypto';
import { comparisonEvidence, scenarioForProbe } from './comparison-evidence.js';
import { markdownCell, sampleTable, table } from './review-tables.js';

// Metric names are enumerated so identifiers, text and unknown fields fail closed.
const metrics = new Set([
  'cpu', 'memory_pused', 'tps', 'tx_error', 'tx_count', 'count', 'tx_time_sum',
  'resp_time', 'response_time', 'response_time_avg', 'response_time_max',
]);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

export function validatePublicationPolicy(policy) {
  if (policy === undefined) return;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
      Object.keys(policy).some(key => !['authorization', 'projectCodes', 'fields', 'includeDifferences', 'includeStatistics'].includes(key)) ||
      typeof policy.authorization !== 'string' || !policy.authorization.trim() ||
      !Array.isArray(policy.projectCodes) || !policy.projectCodes.length || !policy.projectCodes.every(positiveInteger) ||
      !Array.isArray(policy.fields) || !policy.fields.length || !policy.fields.every(field => metrics.has(field)) ||
      ['includeDifferences', 'includeStatistics'].some(key => policy[key] !== undefined && typeof policy[key] !== 'boolean')) {
    throw Error('INVALID_PUBLICATION_POLICY');
  }
}

function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return typeof value === 'string' && /^[-+]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))
    ? value : undefined;
}

export function publicationTables(policy, runs) {
  validatePublicationPolicy(policy);
  const samples = [], statistics = [];
  if (!policy) return { samples, statistics };
  const secret = randomBytes(32);
  const allowed = new Set(policy.fields);
  const approvedSample = s => allowed.has(s.field) &&
    (numericValue(s.mcp) !== undefined || numericValue(s.http) !== undefined);

  for (const { run } of runs) for (const probe of run.probes) {
    const project = probe.evidence?.args?.projectCode;
    const scenario = scenarioForProbe(run, probe);
    if (!policy.projectCodes.includes(project) || scenario?.projectCode !== project ||
        !scenario.compareFields?.some(f => allowed.has(f))) continue;
    // Any independent response used by this report must identify the same project.
    if ([probe.evidence.reference, probe.evidence.referenceV2].some(r => r && r.request?.projectCode !== project))
      continue;
    const c = comparisonEvidence(probe, scenario, approvedSample);
    const approved = c.samples.map(s => {
      const safe = { field: s.field, status: s.status };
      if (s.key) {
        const identity = JSON.stringify([project, c.keys, s.key]);
        safe.key = '행-' + createHmac('sha256', secret).update(identity).digest('hex').slice(0, 16);
      }
      for (const field of ['mcp', 'http', 'expectedDisplay']) safe[field] = numericValue(s[field]);
      if (policy.includeDifferences) {
        for (const field of ['rawDifference', 'normalizedDifference']) safe[field] = numericValue(s[field]);
      }
      return safe;
    });
    if (approved.length) samples.push('#### ' + markdownCell(probe.id) + ' · ' + markdownCell(run.id), '',
      ...sampleTable(approved, true, policy.includeDifferences === true));
    if (policy.includeStatistics && c.fields.every(f => allowed.has(f))) {
      statistics.push([run.id, probe.id, c.mcpRows, c.httpRows, c.comparedRows, c.matchedRows, c.mismatchedRows, c.coverage]);
    }
  }
  return { samples, statistics: statistics.length
    ? table(['실행 ID', '시나리오', 'MCP 반환', 'HTTP 반환', '비교', '일치', '불일치', '범위'], statistics) : [] };
}
