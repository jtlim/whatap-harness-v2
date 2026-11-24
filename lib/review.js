import { withComparisonEvidence } from './comparison-evidence.js';
import { probeDetails } from './report.js';
import { markdownCell, table } from './review-tables.js';
import { publicationTables } from './publication-policy.js';
import { validationScenarios } from './scenarios.js';

export const sections = {
  overview: '작업 개요', reproduction: '문제 발견 및 재현', cause: '원인 분석',
  impact: '영향 범위 및 수정 필요성', changes: '코드 변경 내역',
  before: '수정 전 검증', after: '수정 후 검증', statistics: '전체 비교 통계와 기준',
  comparison: '수정 전후 결과 비교', tests: '단위 테스트 및 회귀 테스트',
  retries: '실패 및 재시도 이력', limits: '검증 범위 및 한계',
  instructions: '재현 절차', evidence: '검증 증거 및 최종 검토 요청',
};

const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const knownStates = new Set(['VERIFIED', 'VALIDATION_FAILED', 'ENVIRONMENT_OR_AUTH',
  'UNVERIFIABLE', 'AI_FAILED', 'SUBMISSION_FAILED', 'SUBMITTED', 'PASS', 'FAIL']);

export function buildReview(manifest, input, attachments, publicationPolicy) {
  if (!['mcp', 'harness', 'audit'].includes(manifest.kind)) throw Error('INVALID_REVIEW_KIND');
  if (!sha(manifest.baselineCommit) || !sha(manifest.candidateCommit) || !sha(manifest.harnessCommit))
    throw Error('REVIEW_COMMIT_REQUIRED');
  if (manifest.publicReviewed !== true) throw Error('PUBLIC_DISCLOSURE_REVIEW_REQUIRED');
  for (const section of Object.keys(sections)) {
    if (typeof manifest.sections?.[section] !== 'string' || !manifest.sections[section].trim())
      throw Error('REVIEW_SECTION_MISSING ' + section);
  }
  if (!attachments.length) throw Error('REVIEW_ATTACHMENT_REQUIRED');
  if (manifest.kind === 'harness' && !attachments.some(a => a.role === 'comparison'))
    throw Error('SAME_INPUT_COMPARISON_ATTACHMENT_REQUIRED');
  const runs = input.map(({ role, run }) => {
    if (!['before', 'after', 'history', 'failure', 'replay'].includes(role) ||
        !safeId(run.id) || !knownStates.has(run.status) || !run.finishedAt || !Array.isArray(run.probes))
      throw Error('INVALID_REVIEW_RUN');
    return { role, run: withComparisonEvidence(run) };
  });
  if (manifest.kind === 'mcp') {
    for (const [role, commit] of [['before', manifest.baselineCommit], ['after', manifest.candidateCommit]]) {
      if (!runs.some(x => x.role === role && x.run.mode === 'live' &&
          x.run.target?.commit === commit && x.run.target?.dirty === false &&
          x.run.harness === manifest.harnessCommit &&
          (role !== 'after' || x.run.status === 'VERIFIED') &&
          x.run.probes.some(p => p.evidence?.reference && typeof p.evidence.mcpText === 'string') &&
          (role !== 'after' || x.run.probes.some(p => p.comparison.comparedRows > 0))))
        throw Error('LIVE_REVIEW_EVIDENCE_REQUIRED ' + role);
    }
  }
  const fixedAfter = new Map(runs.filter(x => x.role === 'after').flatMap(x => x.run.probes)
    .filter(p => p.evidence?.args?.timeRange?.includes('/'))
    .map(p => [p.id, p.evidence.args.timeRange]));
  for (const p of runs.filter(x => x.role === 'before').flatMap(x => x.run.probes)) {
    if (p.evidence?.args?.timeRange?.includes('/') && fixedAfter.has(p.id) &&
        fixedAfter.get(p.id) !== p.evidence.args.timeRange) throw Error('FIXED_REVIEW_WINDOW_MISMATCH ' + p.id);
  }
  for (const { run } of runs) {
    if (run.probes.some(p => !safeId(p.id) || !safeId(p.reason) || !knownStates.has(p.status)))
      throw Error('INVALID_PUBLIC_PROBE_METADATA');
  }
  const content = (...ids) => ids.flatMap(id => ['### ' + sections[id], '', manifest.sections[id], '']);
  const runIndex = table(['역할', '실행 ID', '결과'], runs.map(({ role, run }) => [role, run.id, run.status]));
  const mainRuns = runs.filter(x => ['before', 'after'].includes(x.role));
  const results = new Map();
  for (const { role, run } of mainRuns) for (const probe of run.probes) {
    if (!results.has(probe.id)) results.set(probe.id, { before: [], after: [] });
    results.get(probe.id)[role].push(probe.status + ' · ' + probe.reason);
  }
  const outcomes = results.size ? table(['시나리오', '수정 전', '수정 후'],
    [...results].map(([id, x]) => [id, x.before.join(', ') || null, x.after.join(', ') || null])) : [];
  const scenarioCatalog = validationScenarios({ serverProject: 1, apmProject: 2 });
  const knownPaths = new Set(['/open/api/flush/mxql/path', '/open-mcp/api/flush/mxql/path',
    '/open/api/v2/stat/transaction', '/open/api/v2/stat/error']);
  const conditions = scenarioCatalog.filter(s => results.has(s.id)).map(s => {
    const probes = mainRuns.flatMap(x => x.run.probes.filter(p => p.id === s.id));
    const endpoints = new Set(probes.flatMap(p => [p.evidence?.reference, p.evidence?.referenceV2])
      .filter(r => r?.request?.method === 'POST' && knownPaths.has(r.request.path)).map(r => 'POST ' + r.request.path));
    const windows = new Set(probes.map(p => {
      const requested = p.evidence?.args?.timeRange;
      if (s.negative) return '잘못된 기간 입력';
      if (typeof requested === 'string' && /^\d{1,5}[smhdw]$/.test(requested)) return '상대 ' + requested;
      const w = p.comparison.requestWindow;
      if (requested?.includes('/') && w) return '절대 UTC ' + ((w.etime - w.stime) / 60_000) + '분';
      return '정확한 기간은 로컬 근거 참조';
    }));
    const limits = new Set(probes.map(p => p.evidence?.args?.limit).filter(Number.isSafeInteger));
    const tool = probes.some(p => p.evidence?.args?.path === s.path) ? 'whatap_query_data / ' + s.path : 'whatap_query_data';
    return [s.id, tool, [...endpoints].join(', ') || null, [...windows].join(', '), [...limits].join(', ') || null,
      s.negative ? null : s.matchKeys.join(', '), s.negative ? null : s.compareFields.join(', ')];
  });
  const conditionTable = conditions.length ? ['### 조회 조건', '', ...table(
    ['시나리오', 'MCP 도구 / 경로', '독립 HTTP Endpoint', '기간', '표시 제한', '식별자 키', '지표'], conditions)] : [];
  const counts = table(['실행 ID', '시나리오', 'MCP 반환', 'HTTP 반환', '비교', '일치', '불일치', '범위'],
    runs.flatMap(({run}) => run.probes.map(p => {
      const c = p.comparison;
      return [run.id, p.id, c.mcpRows, c.httpRows, c.comparedRows, c.matchedRows, c.mismatchedRows, c.coverage];
    })));
  const { samples, statistics } = publicationTables(publicationPolicy, runs);
  const header = ['# WhaTap 검수 보고서', '', manifest.sections.overview, '',
    ...table(['기준', '후보', 'Harness'], [[manifest.baselineCommit, manifest.candidateCommit, manifest.harnessCommit]]), ...outcomes];
  const defects = ['## 문제와 수정', '', ...content('reproduction', 'cause', 'impact', 'changes')];
  const validation = ['## 독립 검증', '', ...conditionTable, ...content('comparison', 'before', 'after', 'statistics')];
  const delivery = ['## 회귀 테스트와 재현', '', ...content('tests', 'retries', 'limits', 'instructions'),
    '## 검증 증거와 최종 검토', '', manifest.sections.evidence, '', ...runIndex];
  const publicBody = [...header, ...defects, ...validation,
    ...(statistics.length ? ['### 공개 승인된 비교 통계', '', ...statistics] : []),
    '### 실제 비교 표본 공개 범위', '',
    samples.length
      ? '아래는 공개 승인을 기록한 지표의 실제 표본입니다. 조회 시각은 생략했고 식별자는 보고서 안에서 일관된 별칭으로 표시했습니다.'
      : publicationPolicy
        ? '공개 설정의 프로젝트·지표 범위에 해당하는 수치 표본이 없습니다.'
        : '실제 측정값의 공개 권한이 설정되지 않아 이 PR에서는 표본을 생략했습니다.',
    '', ...samples,
    '권한이 제한된 전체 보고서에는 실제 요청, 시각, 행 식별자, 원값과 정규화 값, 실패 응답과 독립 HTTP 표본이 포함됩니다.', '',
    ...delivery].join('\n');
  const local = [...header, ...defects, ...validation, '### 전체 비교 통계', '', ...counts,
    '### 실행별 실제 요청과 비교 표본', '',
    ...runs.flatMap(({ role, run }, index) => [
      `#### ${role} · ${run.id}`, '',
      ...table(['시작', '종료', '환경', '대상'], [[run.startedAt, run.finishedAt, run.environment, run.target]]),
      ...run.probes.flatMap((p, i) => probeDetails(p, i, `evidence.json#/runs/${index}/run/probes/`)),
      ...(run.events.length ? ['<details>', '<summary>실행 이벤트</summary>', '',
        ...run.events.map(e => `- ${markdownCell(e.stage)} · ${markdownCell(e.status)} · ${markdownCell(e.detail)}`),
        '', '</details>', ''] : []),
    ]),
    ...delivery, '### 로컬 원본과 테스트 로그', '',
    ...attachments.map(a => {
      const link = a.localHref ? `[${markdownCell(a.label)}](<${a.localHref}>)` : markdownCell(a.label);
      return `- ${link} · SHA-256 \`${a.sha256}\``;
    }), '',
  ].join('\n');
  const reviewRuns = runs.map(({ role, run }) => ({ role, run: {
    ...run,
    probes: run.probes.map(({ evidence, ...p }, index) => ({
      ...p, originalPointer: `report.json#/probes/${index}`,
      evidence: {
        args: evidence?.args, mcpPeriod: evidence?.mcpPeriod, mcpIsError: evidence?.mcpIsError,
        reference: evidence?.reference && { request: evidence.reference.request, status: evidence.reference.status },
        referenceV2: evidence?.referenceV2 && { request: evidence.referenceV2.request, status: evidence.referenceV2.status },
      },
    })),
  } }));
  return { body: publicBody, local, evidence: { version: 1, runs: reviewRuns, attachments, kind: manifest.kind } };
}
