import { markdownCell, table } from './review-tables.js';

export const rationaleFields = {
  title: '변경', classification: '분류', scope: '개선 대상',
  unchanged: '유지할 경우의 제약·위험', userImpact: '사용자·서비스 영향',
  alternatives: '대응 가능성과 대안', choice: '현재 방식을 선택한 이유',
  benefit: '구체적 이점', compatibility: '부작용·호환성', mergeBasis: '반영 근거',
};

const classifications = new Set(['구현 결함 수정', '기능 개선', '호환성 개선', '보고·운영 개선']);
const scopes = new Set(['MCP 동작 품질', 'Harness 검증', 'Harness 보고·운영']);

export function renderMergeRationale(items, required) {
  if (items === undefined && !required) return [];
  if (!Array.isArray(items) || (required && !items.length)) throw Error('MERGE_RATIONALE_REQUIRED');
  return items.flatMap(item => {
    for (const key of Object.keys(rationaleFields)) {
      if (typeof item?.[key] !== 'string' || !item[key].trim())
        throw Error('MERGE_RATIONALE_FIELD_REQUIRED ' + key);
    }
    if (!classifications.has(item.classification) || !scopes.has(item.scope))
      throw Error('INVALID_MERGE_RATIONALE_CLASSIFICATION');
    return ['### ' + markdownCell(item.title), '',
      ...table(['분류', '개선 대상'], [[item.classification, item.scope]]),
      ...table(['검토 항목', '근거'], Object.entries(rationaleFields).slice(3)
        .map(([field, label]) => [label, item[field]]))];
  });
}
