import { withComparisonEvidence } from './comparison-evidence.js';
import { probeDetails } from './report.js';

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

export function buildReview(manifest, input, attachments) {
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
  const publicSections = Object.entries(sections).flatMap(([id, title]) => [
    '## ' + title, '', manifest.sections[id], '',
  ]);
  const publicRuns = ['## 실행 근거 색인', '',
    '| 역할 | 실행 ID | 결과 |', '| --- | --- | --- |',
    ...runs.map(({ role, run }) => `| ${role} | ${run.id} | ${run.status} |`), '',
    '원본 응답, 조회 인수의 민감한 값, 행 식별자 및 수치 표본은 권한이 제한된 로컬 상세 보고서에서 확인할 수 있습니다.', ''];
  if (manifest.publishCounts === true) {
    publicRuns.push('| 실행 | 시나리오 | 상태 | MCP 행 | HTTP 행 | 비교/일치/불일치 |',
      '| --- | --- | --- | ---: | ---: | --- |');
    for (const { run } of runs) {
      for (const p of run.probes) {
        if (!safeId(p.id) || !knownStates.has(p.status)) throw Error('INVALID_PUBLIC_PROBE_METADATA');
        const c = p.comparison;
        const n = value => Number.isSafeInteger(value) ? value : '—';
        publicRuns.push(`| ${run.id} | ${p.id} | ${p.status} | ${n(c.mcpRows)} | ${n(c.httpRows)} | ${n(c.comparedRows)}/${n(c.matchedRows)}/${n(c.mismatchedRows)} |`);
      }
    }
    publicRuns.push('', '값 비교는 양쪽에 중복 없이 존재하는 식별자의 교집합에 적용됩니다. 조회 제한과 키 차이의 의미는 상세 비교 통계에 기록합니다.', '');
  }
  const header = ['# WhaTap 검수 보고서', '',
    `- 기준 \`${manifest.baselineCommit}\``,
    `- 후보 \`${manifest.candidateCommit}\``,
    `- Harness \`${manifest.harnessCommit}\``, ''];
  const publicBody = [...header, ...publicSections, ...publicRuns].join('\n');
  const local = [...header, ...publicSections, '## 로컬 원본 근거', '',
    ...attachments.map(a => `- ${a.label} / ${a.path} / SHA-256 \`${a.sha256}\``),
    ...runs.flatMap(({ role, run }, index) => [
      '', `### ${role} / ${run.id}`, '',
      `원본 \`${run.id}/report.json\`` ,
      `시작 ${run.startedAt ?? '기록 없음'} / 종료 ${run.finishedAt}`,
      `실행 환경 ${JSON.stringify(run.environment ?? {})}`,
      `대상 ${JSON.stringify(run.target ?? {})}`,
      ...run.events.map(e => `- ${e.stage} / ${e.status} / ${e.detail ?? ''}`),
      ...run.probes.flatMap((p, i) => probeDetails(p, i).map(line =>
        line.replace('report.json#/probes/', `evidence.json#/runs/${index}/run/probes/`))),
    ]), '',
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
