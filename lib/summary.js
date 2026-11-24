/** Verify formatted Summary fields against *unrounded API rows* corresponding to displayed records. */
export function checkSummary(text, s, full, shown) {
    const summary = /\*\*Summary\*\*\s*\(([^\n)]*)\):\s*([^\n]+)/.exec(text);
    if (!summary)
        return { code: 'MCP_SUMMARY', ok: true, detail: 'MCP 요약 통계 없음 (검증 대상 없음)' };
    const fields = summary[2].split(/\s+\|\s+/);
    const key = (r) => JSON.stringify((s.matchKeys ?? []).map(k => typeof r[k] === 'number' ? String(r[k]) : r[k]));
    const map = new Map(full.map(r => [key(r), r]));
    const originals = shown.map(r => map.get(key(r))).filter((r) => !!r);
    if (originals.length !== shown.length)
        return { code: 'MCP_SUMMARY', ok: false, detail: '요약에 대응하는 원본 행을 확정할 수 없음' };
    const reasons = [];
    let matched = 0;
    for (const piece of fields) {
        const m = /^\*\*([^*]+)\*\*\s*\(([-\d.eE+]+)\s*[–-]\s*([-\d.eE+]+).*?,\s*avg\s+([-\d.eE+]+)/.exec(piece.trim());
        if (!m) {
            reasons.push(`요약 해석 불가: ${piece.slice(0, 50)}`);
            continue;
        }
        const col = m[1];
        const vals = originals.map(r => r[col]).filter((v) => typeof v === 'number' && Number.isFinite(v));
        if (vals.length < 2) {
            reasons.push(`${col}: 원본 숫자 데이터 부족`);
            continue;
        }
        const f = (v) => Number.isInteger(v) ? String(v) : v.toFixed(1);
        const actual = [f(Math.min(...vals)), f(Math.max(...vals)), f(vals.reduce((a, b) => a + b, 0) / vals.length)];
        const expected = [m[2], m[3], m[4]];
        if (actual.some((v, i) => Number(v) !== Number(expected[i])))
            reasons.push(`${col}: MCP [${expected}] / API 계산 [${actual}]`);
        else
            matched++;
    }
    const rowPrefix = summary[1].match(/^(\d+)(?:\s+of\s+(\d+))?\s+rows/);
    if (rowPrefix && Number(rowPrefix[1]) !== shown.length)
        reasons.push(`요약의 표시 행 수 ${rowPrefix[1]} != 실제 표 ${shown.length}`);
    return { code: 'MCP_SUMMARY', ok: reasons.length === 0 && matched > 0,
        detail: reasons.length ? reasons.join('; ') : `표시된 ${shown.length}행의 원본 수치로 계산한 요약 ${matched}개 필드 일치` };
}
