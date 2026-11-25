const labels = {
  MATCH: '일치', DIFFER: '불일치', HTTP_ONLY: 'HTTP에만 존재',
  HTTP_UNPAIRED: '대응하지 않은 HTTP 행', MCP_UNPAIRED: '대응하지 않은 MCP 행',
  MCP_ONLY: 'MCP에만 존재', HTTP_REFERENCE_ONLY: 'HTTP 대조 응답',
};

export function markdownCell(value) {
  if (value == null) return '—';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.replace(/[&<>`|\\\[\]*_~]/g, char => '&#' + char.charCodeAt(0) + ';').replace(/\r?\n/g, ' ');
}

export function table(headers, rows) {
  const line = values => '| ' + values.map(markdownCell).join(' | ') + ' |';
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line), ''];
}

export function details(summary, lines) {
  return lines.length ? ['<details>', '<summary>' + markdownCell(summary) + '</summary>', '',
    ...lines, '', '</details>', ''] : [];
}

export function formatMeasurement(value, difference = false) {
  if (typeof value !== 'number' &&
      (typeof value !== 'string' || !/^[-+]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))) return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n === 0) return n === value ? '0' : String(value);
  if (Math.abs(n) < 0.001 || (difference && Math.abs(n) >= 1e6))
    return n.toExponential(difference ? 4 : 7).replace(/\.?0+e/, 'e');
  if (!difference && Number.isInteger(n)) return String(value);
  return String(Number(n.toPrecision(difference ? 5 : 8)));
}

const utc = time => Number.isFinite(time) ? new Date(time).toISOString() : undefined;
const range = window => window ? utc(window.stime) + ' → ' + utc(window.etime) : undefined;

export function sampleTable(samples, published = false, includeDifferences = true) {
  return table([published ? '조회 시작 기준 위치 (ms)' : '조회 시각 (UTC)',
    '식별자', '지표', 'MCP 값', 'HTTP 원값', 'HTTP 정규화',
    ...(includeDifferences ? ['차이 (원값)', '차이 (정규화)'] : []), '판정'], samples.map(s => [
    published ? s.offsetMs : utc(s.time), s.key, s.field, formatMeasurement(s.mcp), formatMeasurement(s.http), formatMeasurement(s.expectedDisplay),
    ...(includeDifferences ? [formatMeasurement(s.rawDifference, true), formatMeasurement(s.normalizedDifference, true)] : []), labels[s.status] ?? '확인 불가',
  ]));
}

export function localProbeTables(p) {
  const c = p.comparison, e = p.evidence ?? {};
  const row = (name, item) => [name, item?.request?.method, item?.request?.path, item?.status, item?.request?.projectCode, item?.request?.payload];
  const i = c.identities;
  const checks = (codes) => p.checks.filter(x => codes.includes(x.code))
    .map(x => x.code + ' ' + (x.ok ? '통과' : '실패')).join(', ') || '미실행';
  return [
    ...table(['조회 조건', '기록'], [
      ['MCP 도구', 'whatap_query_data'], ['MCP 실제 인수', e.args],
      ['표시 Period (UTC)', range(e.mcpPeriod)], ['HTTP 비교 구간 (UTC)', range(c.requestWindow)],
      ['식별자 키', c.keys.join(', ')], ['비교 필드', c.fields.join(', ')],
      ['허용 오차', c.absoluteTolerance], ['MCP 제한 / 안내', c.mcpLimit == null ? null : c.mcpLimit + ' / ' + (c.limitNotice ?? '미확인')],
    ]),
    ...table(['독립 HTTP', '방법', 'Endpoint', '상태', '프로젝트 코드', '실제 인수'], [
      row('기준 조회', e.reference), ...(e.referenceV2 ? [row('별도 집계', e.referenceV2)] : []),
    ]),
    ...(typeof e.mcpText === 'string' && (e.mcpIsError || !c.comparedRows) ? [
      '**MCP 응답 발췌**', '', ...e.mcpText.slice(0, 800).split(/\r?\n/).map(line => '> ' + markdownCell(line)), '',
    ] : []),
    ...(c.comparisonUnavailable ? ['행 비교 미실행 · ' + markdownCell(c.comparisonUnavailable), ''] : []),
    ...(c.samples.length ? sampleTable(c.samples) : []),
    ...table(['통계', 'MCP', 'HTTP'], [
      ['반환 행', c.mcpRows, c.httpRows], ['전용 키', i?.mcpOnly, i?.httpOnly],
      ['식별자 누락', i?.mcpMissingKeys, i?.httpMissingKeys], ['중복 행', i?.mcpDuplicateRows, i?.httpDuplicateRows],
      ...(c.series ? [['고유 시각', c.series.mcpUniqueTimes, c.series.httpUniqueTimes]] : []),
    ]),
    ...table(['비교 행', '일치', '불일치', '범위', '집계 검사'], [[
      c.comparedRows, c.matchedRows, c.mismatchedRows, c.coverage,
      checks(['APM_GROUP_AGGREGATES', 'APM_V2_AGGREGATES']),
    ]]),
    ...(c.series ? ['예상 표본 수 (버킷 시작/종료 기준) · ' + c.series.expectedStartLabels + '/' + c.series.expectedEndLabels, ''] : []),
    ...(Object.keys(c.fieldErrors).length ? table([
      '지표', '수치 쌍', '불일치', 'MCP 필드 누락', 'HTTP 필드 누락', '최대 차이 (원값)', '최대 차이 (정규화)',
    ], Object.entries(c.fieldErrors).map(([field, f]) => [field, f.numericPairs, f.mismatches,
      f.missingMcp, f.missingHttp, formatMeasurement(f.maxRawAbsoluteError, true), formatMeasurement(f.maxNormalizedAbsoluteError, true)])) : []),
    ...(!c.verdictComparedFields && c.comparedRows !== undefined ? ['교집합 통계는 판정 이후에 계산한 진단입니다.', ''] : []),
  ];
}
