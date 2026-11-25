import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withComparisonEvidence } from './comparison-evidence.js';
import { localProbeTables, markdownCell, table, details } from './review-tables.js';

export function publicReport(run) {
  const lines = [
    '# WhaTap MCP 독립 검증', '',
    run.mode === 'replay' ? '저장된 입력을 현재 비교기로 다시 판정했습니다.' :
      '선택한 MCP 데이터 조회 시나리오를 독립 HTTP 응답과 대조합니다.', '',
    `- 실행 ID \`${run.id}\``,
    `- MCP 기준 \`${run.baseline}\``,
    `- Harness 기준 \`${run.harness ?? '확인 불가'}\``,
    `- 상태 **${run.status}**`,
    ...run.events.map(e => `- ${e.stage} / ${e.status}`),
    ...(run.aiAnswer ? [`- 구조화 AI 답변 **${run.aiAnswer.status}** · ${run.aiAnswer.reason} · ${run.aiAnswer.responsibility}`] : []),
    '', '| 단계 | 시나리오 | 결과 | 근거 코드 |', '| --- | --- | --- | --- |',
    ...run.probes.map(p => `| ${p.phase} | ${p.id} | ${p.status} | ${p.reason} |`),
    '',
    '절대시간 조회는 수정 전후 동일한 구간을 사용합니다. 상대시간은 각 MCP 응답에 표시된 Period로 별도 HTTP 조회를 수행하므로 수정 전후 값을 직접 비교하지 않습니다.',
    'Server CPU·메모리와 APM의 TPS·오류 건수 계열은 HTTP와 MCP의 행 키 및 값이 일치해야 합니다. 5초 시계열은 요청 구간의 전체 표본 격자를 확인합니다.',
    'APM 통계는 제한이 명시된 경우 표시 행을 비교합니다. Period 안에 완전히 포함되는 5분 버킷은 별도 v2 API와 그룹 집계를 검증합니다.',
    run.aiAnswer ? '이 실행은 MCP 출력과 정해진 질문의 구조화 AI 답변을 별도로 검증합니다. 자유 형식 답변은 범위 밖입니다.' :
      '검증은 MCP가 출력한 표와 요약에 적용됩니다. 자유 형식의 AI 답변이나 데모 범위 밖의 기능은 검증 범위에 포함되지 않습니다.',
    '프로젝트 식별자, 실제 응답, 도구 로그 및 AI 분석 원문은 서비스 정보 노출을 방지하기 위해 로컬 증거에만 저장합니다.',
    '병합 여부는 사람이 판단합니다.',
  ];
  return lines.join('\n') + '\n';
}

function duplicateDetails(p) {
  const counts = p.evidence?.recordKeys;
  const compared = p.evidence?.recordComparison;
  if (!counts?.mcp?.groups && !counts?.http?.groups) return [];
  const sides = [['MCP 표시', counts.mcp], ['HTTP 원본', counts.http], ['HTTP 비교 범위', compared?.http]];
  return [
    ...details('중복 복합 키 대조', [
      ...table(['대상', '중복 키 그룹', '그룹에 속한 전체 행', '첫 행을 제외한 추가 행', '측정값이 다른 그룹'],
        sides.filter(([, c]) => c).map(([side, c]) =>
          [side, c.groups, c.rows, c.additionalRows, c.distinctMeasurements])),
      `공통 중복 키 ${counts.sharedDuplicateKeys ?? '확인 불가'}개. 생성 원인 미확인.`,
      ...(compared ? [
        `비교 범위의 행 수 차이로 확인된 MCP 추가 ${compared.mcpOnly}행, 누락 ${compared.httpOnly}행.`,
        p.status === 'PASS'
          ? '확정된 비교 범위에서 각 레코드의 개수와 측정값이 일대일로 일치했습니다.'
          : `최종 판정 ${p.status} · ${p.reason}. 행 키의 반복 자체는 판정 실패 조건이 아닙니다.`,
        ...table(['복합 키', 'HTTP 행', 'MCP 행', '일대일 대응', '측정값'],
          compared.duplicateGroups.map(g => [g.key, g.httpRows, g.mcpRows, g.matchedRows, g.values])),
      ] : ['독립 비교 범위나 행 대조가 확정되지 않았습니다.']),
    ]),
  ];
}

export function probeDetails(p, index, pointer = 'report.json#/probes/') {
  return [
    `#### ${markdownCell(p.id)} · ${markdownCell(p.phase)}`, '',
    `**${markdownCell(p.status)}** · \`${p.reason}\` · \`${pointer}${index}\``, '',
    ...localProbeTables(p),
    ...duplicateDetails(p),
    '<details>', '<summary>기계 검증 세부 판정</summary>', '',
    ...p.checks.map(c => `- ${c.ok ? '통과' : '미통과'} · ${markdownCell(c.code)} · ${markdownCell(c.detail)}`),
    '', '</details>', '',
  ];
}

export async function saveReport(directory, input, redact) {
  const run = withComparisonEvidence(input);
  const details = [
    '## 로컬 실행 기록', '',
    `시작 ${run.startedAt ?? '기록 없음'} / 종료 ${run.finishedAt ?? '진행 중'}`,
    `요청 ${run.request ?? '별도 기록 없음'}`,
    `실행 환경 ${JSON.stringify(run.environment ?? {})}`,
    `검증 대상 ${JSON.stringify(run.target ?? {})}`,
    `재생 판정 비교 ${JSON.stringify(run.replay ?? [])}`,
    `도구 지원 근거 ${JSON.stringify(run.capabilities ?? {})}`,
    `실행 조건 \`${JSON.stringify(run.conditions)}\``,
    `변경 파일 ${run.files?.join(', ') ?? '없음'}`,
    `MCP 후보 커밋 ${run.mcpCommit ?? '없음'}`,
    `PR ${run.pr ?? '없음'}`,
    '', '### 단계와 재시도 이력', '',
    ...run.events.map(e => `- ${e.at} / ${e.stage} / ${e.status}${e.detail ? ' / ' + e.detail : ''}`),
    '', '### 독립 검증 세부 근거', '',
    ...run.probes.flatMap((p, i) => probeDetails(p, i)),
    ...(run.aiAnswer ? [
      '### 구조화 AI 답변과 독립 계산', '',
      `MCP 호출 ${markdownCell(JSON.stringify(run.aiAnswer.call))}`,
      `제출 답변 ${markdownCell(run.aiAnswer.submission.text ?? 'AI 실행 실패')}`,
      `독립 계산 ${markdownCell(JSON.stringify(run.aiAnswer.independent))}`,
      '', '| 항목 | 일치 | 표시 기준 기대값 | HTTP 원값 대비 차이 |', '| --- | --- | --- | --- |',
      ...run.aiAnswer.checks.map(c => `| ${c.field} | ${c.ok == null ? '—' : c.ok ? 'PASS' : 'FAIL'} | ${c.expected ?? '—'} | ${c.delta ?? '—'} |`),
      '', 'HTTP 원본과 요청은 report.json의 해당 MCP 프로브에 있습니다.', '',
    ] : []),
    '### AI 분석 및 수정 설명', '',
    run.agentNotes?.join('\n\n') || '기록 없음', '',
    '응답 원문과 실제 행·집계 값은 report.json에 있습니다. 각 명령의 출력과 후보 diff는 실행 디렉터리에 저장합니다.',
  ].join('\n');
  await writeFile(join(directory, 'report.md'), redact(publicReport(run) + '\n' + details));
  await writeFile(join(directory, 'report.json'), redact(JSON.stringify(run, null, 2)) + '\n');
  await writeFile(join(directory, 'public.md'), publicReport(run));
}
