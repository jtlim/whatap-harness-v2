// The two WhaTap APIs expose different grouping keys for the same statistics.
// This cross-check uses the same aligned fixed window, never a guessed relative window.
export const FIVE_MIN = 300000;
const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => {
    if (typeof v !== 'number' && typeof v !== 'string')
        return null;
    if (typeof v === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v))
        return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const normalHash = (v) => {
    if (typeof v === 'number' && Number.isSafeInteger(v))
        return String(v);
    if (typeof v === 'string' && /^-?\d+$/.test(v))
        return String(BigInt(v));
    return null;
};
const key = (parts) => parts.some(v => v === null) ? null : JSON.stringify(parts);
const expectedFields = (mode) => mode === 'transaction'
    ? [['tx_count', 'count', 0], ['tx_error', 'error', 0], ['tx_time_sum', 'timeSum', 0.01]]
    : [['count', 'count', 0]];
function groupKey(mode, r, fromV2) {
    return mode === 'transaction' ? normalHash(r[fromV2 ? 'serviceHash' : 'tx_hash']) :
        key([normalHash(r.classHash), normalHash(r.serviceHash), normalHash(r[fromV2 ? 'msgHash' : 'msg'])]);
}
function compareAggregate(mode, rows, v2, w) {
    const cols = expectedFields(mode);
    const a = new Map();
    const b = new Map();
    const buckets = new Set();
    let invalidRaw = 0, invalidV2 = 0, dupV2 = 0, invalidWindow = 0;
    for (const r of rows) {
        const t = finite(r.time);
        if (t === null || t % FIVE_MIN !== 0) {
            invalidWindow++;
            continue;
        }
        if (t < w.stime || t >= w.etime)
            continue;
        buckets.add(t);
        const k = groupKey(mode, r, false);
        if (k === null) {
            invalidRaw++;
            continue;
        }
        let x = a.get(k);
        if (!x) {
            x = {};
            for (const [src] of cols)
                x[src] = 0;
            a.set(k, x);
        }
        for (const [src] of cols) {
            const n = finite(r[src]);
            if (n === null) {
                invalidRaw++;
                break;
            }
            x[src] += n;
        }
    }
    for (const r of v2) {
        const k = groupKey(mode, r, true);
        if (k === null) {
            invalidV2++;
            continue;
        }
        if (b.has(k)) {
            dupV2++;
            continue;
        }
        const x = {};
        let valid = true;
        for (const [src, dst] of cols) {
            const n = finite(r[dst]);
            if (n === null) {
                valid = false;
                break;
            }
            x[src] = n;
        }
        if (!valid) {
            invalidV2++;
            continue;
        }
        b.set(k, x);
    }
    const expectedCount = (w.etime - w.stime) / FIVE_MIN;
    const completeBuckets = Number.isInteger(expectedCount) && expectedCount > 0 && buckets.size === expectedCount &&
        [...buckets].every(t => t >= w.stime && t < w.etime);
    const badInputs = invalidRaw > 0 || invalidV2 > 0 || dupV2 > 0 || invalidWindow > 0 || !completeBuckets;
    let missingA = 0, missingB = 0, different = 0, matching = 0;
    for (const [k, one] of a) {
        const other = b.get(k);
        if (!other) {
            missingB++;
            continue;
        }
        let same = true;
        for (const [src, , tolerance] of cols) {
            if (!Number.isFinite(one[src]) || !Number.isFinite(other[src]) || Math.abs(one[src] - other[src]) > tolerance) {
                same = false;
                break;
            }
        }
        if (same)
            matching++;
        else {
            different++;
        }
    }
    for (const k of b.keys())
        if (!a.has(k))
            missingA++;
    const ok = !badInputs && missingA === 0 && missingB === 0 && different === 0 && matching > 0;
    // F6: the visible MCP rows and summary have already passed the independent
    // same-MXQL transport comparison. Divergence between two HTTP reference APIs
    // therefore cannot authorize a change to MCP source code.
    const verdict = badInputs ? 'UNVERIFIABLE' : ok ? 'PASS' : 'UNVERIFIABLE';
    const reason = badInputs ? 'STATS_AGGREGATE_INCOMPLETE' : ok ? 'STATS_AGGREGATE_MATCH' : 'REFERENCE_INCONSISTENCY';
    const check = { code: 'APM_V2_AGGREGATES', ok, detail:
        `5분 버킷 ${buckets.size}/${expectedCount}, MXQL 그룹 ${a.size}, v2 그룹 ${b.size}, 일치 ${matching}, 값 차이 ${different}, 누락 ${missingA + missingB}` };
    return { verdict, reason, check, aggregates: { mxql: [...a], v2: [...b] } };
}

export function compareApmV2(scenario, rawRows, result, window) {
  const body = result.body;
  if (!result.ok || result.status !== 200 || !Array.isArray(body?.data) ||
      !body.data.every(obj) || body.data.length === 0 ||
      finite(body.total) !== body.data.length || finite(body.retrievedTotal) !== body.data.length) {
    return { verdict: 'UNVERIFIABLE', reason: 'APM_V2_INCOMPLETE',
      check: { code: 'APM_V2_COMPLETENESS', ok: false, detail: 'v2 API 페이지 완전성을 확인할 수 없습니다.' } };
  }
  return compareAggregate(scenario.statisticsMode, rawRows, body.data, window);
}
