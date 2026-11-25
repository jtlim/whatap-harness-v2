import { details, table } from './review-tables.js';

const filled = value => typeof value === 'string' && value.trim().length > 0;

export function renderChangeEvidence(manifest, attachments, required) {
  const tests = manifest.testDetails;
  if (required && (!Array.isArray(tests) || !tests.some(t => t?.status === 'PASS')))
    throw Error('REVIEW_TEST_DETAILS_REQUIRED');
  if (Array.isArray(tests)) {
    for (const t of tests) {
      if (!filled(t?.purpose) || !filled(t.command) ||
          !['PASS', 'FAIL', 'UNVERIFIABLE', 'NOT_RUN'].includes(t.status))
        throw Error('INVALID_REVIEW_TEST_DETAIL');
      if (t.status === 'NOT_RUN') {
        if (!filled(t.reason)) throw Error('REVIEW_TEST_REASON_REQUIRED');
        continue;
      }
      const evidence = attachments.find(a => a.label === t.evidence &&
        ['test', 'reproduction', 'comparison'].includes(a.role));
      if (!evidence || !filled(t.proof) || !evidence.content?.includes(t.proof) || !(Number.isInteger(t.exitCode) || (t.exitCode === null && filled(t.reason))) ||
          (t.status === 'PASS' ? t.exitCode !== 0 : t.exitCode === 0))
        throw Error('REVIEW_TEST_EVIDENCE_REQUIRED');
      if (t.status === 'UNVERIFIABLE' && !filled(t.reason)) throw Error('REVIEW_TEST_REASON_REQUIRED');
    }
  }
  const testTable = Array.isArray(tests) && tests.length ? table(
    ['명령', '확인 목적', '판정', '종료 코드', '첨부 근거', '사유'],
    tests.map(t => [t.command, t.purpose, t.status, t.exitCode, t.evidence, t.reason])) : [];

  const patches = attachments.filter(a => a.role === 'diff');
  if (required && patches.length !== 1) throw Error('REVIEW_GIT_DIFF_REQUIRED');
  const patch = patches[0]?.content;
  if (!patch) return { testTable, localCode: [], publicCode: [] };
  const files = [...patch.matchAll(/^diff --git a\/([^\r\n ]+) b\/([^\r\n ]+)$/gm)];
  if (!files.length || !/^@@ /m.test(patch) || files.some(m => m.slice(1).some(path => !/^[\w./-]+$/.test(path))))
    throw Error('INVALID_REVIEW_GIT_DIFF');
  const list = table(['변경 파일'], [...new Set(files.map(m => m[2]))].map(path => [path]));
  // Build artifacts are listed above and stay in the local patch attachment.
  const examples = patch.split(/(?=^diff --git )/m)
    .filter(part => !/^diff --git a\/(dist|build)\//.test(part)).join('').trimEnd();
  const code = examples ? details('Git diff의 수정 전후 코드', [
    '````diff', examples, '````',
  ]) : [];
  return { testTable, localCode: [...list, ...code], publicCode: [...list,
    ...(manifest.codePublicReviewed === true ? code : ['코드 비교 상세는 로컬 Git diff 첨부에 있습니다.', ''])] };
}
