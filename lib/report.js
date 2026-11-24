import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function publicReport(run) {
  const lines = [
    '# WhaTap MCP 독립 검증', '',
    '깨끗한 MCP 기준 커밋에서 조회 기간 문제를 재현하고, Codex가 수정한 뒤 같은 검증을 실행합니다.', '',
    `- 실행 ID \`${run.id}\``,
    `- MCP 기준 \`${run.baseline}\``,
    `- Harness 기준 \`${run.harness ?? '확인 불가'}\``,
    `- 상태 **${run.status}**`,
    ...run.events.map(e => `- ${e.stage} / ${e.status}`),
    '', '| 단계 | 시나리오 | 결과 | 근거 코드 |', '| --- | --- | --- | --- |',
    ...run.probes.map(p => `| ${p.phase} | ${p.id} | ${p.status} | ${p.reason} |`),
    '',
    '절대시간 조회는 수정 전후 동일한 구간을 사용합니다. 상대시간은 각 MCP 응답에 표시된 Period로 별도 HTTP 조회를 수행하므로 수정 전후 값을 직접 비교하지 않습니다.',
    'Server CPU·메모리와 APM의 TPS·오류 건수 계열은 HTTP와 MCP의 행 키 및 값이 일치해야 합니다. 5초 시계열은 요청 구간의 전체 표본 격자를 확인합니다.',
    'APM 통계는 제한이 명시된 경우 표시 행을 비교합니다. 같은 절대시간의 전체 5분 버킷은 별도 v2 API와 그룹 집계를 검증합니다.',
    '검증은 MCP가 출력한 표와 요약에 적용됩니다. 자유 형식의 AI 답변이나 데모 범위 밖의 기능은 검증 범위에 포함되지 않습니다.',
    '프로젝트 식별자, 실제 응답, 도구 로그 및 AI 분석 원문은 서비스 정보 노출을 방지하기 위해 로컬 증거에만 저장합니다.',
    '병합 여부는 사람이 판단합니다.',
  ];
  return lines.join('\n') + '\n';
}

export async function saveReport(directory, run, redact) {
  const details = [
    '## 로컬 실행 기록', '',
    `실행 조건 \`${JSON.stringify(run.conditions)}\``,
    `변경 파일 ${run.files?.join(', ') ?? '없음'}`,
    `MCP 후보 커밋 ${run.mcpCommit ?? '없음'}`,
    `PR ${run.pr ?? '없음'}`,
    '', '### 단계와 재시도 이력', '',
    ...run.events.map(e => `- ${e.at} / ${e.stage} / ${e.status}${e.detail ? ' / ' + e.detail : ''}`),
    '', '### 독립 검증 세부 근거', '',
    ...run.probes.flatMap(p => [
      `#### ${p.phase} / ${p.id}`, '',
      `- 판정 ${p.status} (${p.reason})`,
      `- 요청 \`${JSON.stringify(p.evidence.args)}\``,
      `- MCP Period \`${JSON.stringify(p.evidence.mcpPeriod ?? null)}\``,
      `- HTTP 요청 \`${JSON.stringify(p.evidence.reference?.request ?? null)}\``,
      ...p.checks.map(c => `- ${c.ok ? '통과' : '미통과'} ${c.detail}`),
      '',
    ]),
    '### AI 분석 및 수정 설명', '',
    run.agentNotes?.join('\n\n') || '기록 없음', '',
    '응답 원문과 실제 행·집계 값은 report.json에 있습니다. 각 명령의 출력과 후보 diff는 실행 디렉터리에 저장합니다.',
  ].join('\n');
  await writeFile(join(directory, 'report.md'), redact(publicReport(run) + '\n' + details));
  await writeFile(join(directory, 'report.json'), redact(JSON.stringify(run, null, 2)) + '\n');
  await writeFile(join(directory, 'public.md'), publicReport(run));
}
