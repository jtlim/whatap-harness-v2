import { isDeepStrictEqual } from 'node:util';
/**
 * MXQL 5-second series may label the final bucket with the exact `etime`.
 * Permit that *single aligned boundary* for time-series metrics only; the
 * candidate must still have the same key and value in the independent HTTP
 * response. Other domains and timestamps beyond `etime` remain exclusive.
 */
export function isWithinTimeWindow(s, time) {
    if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < s.stime)
        return false;
    if (time < s.etime)
        return true;
    const step = s.expectedStepMs;
    return time === s.etime && s.domain === 'timeseries' &&
        typeof step === 'number' && Number.isSafeInteger(step) && step > 0 && time % step === 0;
}
function records(body) {
    const value = body && typeof body === 'object' && !Array.isArray(body) && 'data' in body
        ? body.data : body;
    if (!Array.isArray(value))
        return null;
    const data = value.filter(item => !item || typeof item !== 'object' || !('_head_' in item));
    if (!data.every(item => item !== null && typeof item === 'object' && !Array.isArray(item)))
        return null;
    return data;
}
export function assessReference(s, response, options = {}) {
    const checks = [];
    if (!response || typeof response !== 'object')
        return {
            checks: [{ code: 'INVALID_REFERENCE', ok: false, detail: 'HTTP 응답 객체를 읽을 수 없습니다' }],
            rows: null, complete: false,
        };
    const r = response;
    checks.push({ code: 'HTTP_OK', ok: r.status === 200 && r.ok === true,
        detail: `HTTP 상태: ${String(r.status)}; 정상 응답: ${String(r.ok)}` });
    const rows = records(r.body);
    checks.push({ code: 'PARSE_ROWS', ok: rows !== null,
        detail: rows ? `데이터 행: ${rows.length}건` : '구조화된 데이터 배열을 찾지 못했습니다' });
    const body = r.body && typeof r.body === 'object' && !Array.isArray(r.body)
        ? r.body : {};
    const total = typeof body.total === 'number' ? body.total : undefined;
    const retrievedTotal = typeof body.retrievedTotal === 'number' ? body.retrievedTotal : undefined;
    let complete = rows !== null && r.status === 200 && r.ok === true;
    if (total !== undefined || retrievedTotal !== undefined) {
        const ok = total !== undefined && retrievedTotal !== undefined &&
            total === retrievedTotal && rows !== null && rows.length === retrievedTotal;
        checks.push({ code: 'STATS_COMPLETENESS', ok,
            detail: `전체 ${String(total)}건 / API 반환 ${String(retrievedTotal)}건 / 실제 데이터 ${rows?.length ?? '확인 불가'}건` });
        if (!ok)
            complete = false;
    }
    if (rows) {
        const within = rows.every(row => row.time === undefined || isWithinTimeWindow(s, row.time));
        const endpointRows = rows.filter(row => row.time === s.etime).length;
        checks.push({ code: 'TIME_WINDOW', ok: within, detail: within
                ? `확인 가능한 시각은 조회 구간 내에 있습니다${endpointRows ? ` (끝점 정렬 시계열 ${endpointRows}행 포함; HTTP 값 대조 필요)` : ''}`
                : '조회 범위 밖의 타임스탬프가 존재합니다' });
        if (!within)
            complete = false;
        if (s.expectedStepMs && !options.skipStepCoverage) {
            const times = [...new Set(rows.map(row => row.time).filter((t) => typeof t === 'number'))].sort((a, b) => a - b);
            const step = s.expectedStepMs;
            // Accept both timestamp conventions: bucket starts [stime, etime)
            // and bucket ends (stime, etime]. For unaligned bounds, both grids
            // naturally coincide. Do not fabricate missing samples in LLM mode.
            const matchGrid = (first, last) => {
                const expected = Math.max(0, Math.floor((last - first) / step) + 1);
                return times.length === expected &&
                    (expected === 0 || (times[0] === first && times[times.length - 1] === last)) &&
                    times.every((t, i) => i === 0 || t - times[i - 1] === step);
            };
            const firstStart = Math.ceil(s.stime / step) * step;
            const lastStart = Math.floor((s.etime - 1) / step) * step;
            const firstEnd = Math.floor(s.stime / step) * step + step;
            const lastEnd = Math.floor(s.etime / step) * step;
            const ok = matchGrid(firstStart, lastStart) ||
                (s.domain === 'timeseries' && matchGrid(firstEnd, lastEnd));
            checks.push({ code: 'TIMESERIES_COVERAGE', ok,
                detail: `고유 시각 ${times.length}개 / 간격 ${step}ms / 버킷 시작·종료 경계 규칙 검증` });
            if (!ok)
                complete = false;
        }
    }
    return { checks, rows, complete, total, retrievedTotal };
}
/**
 * The reference HTTP agent always reports the request it actually sent.
 * Validate that metadata before trusting returned rows as an independent reference.
 * This does not establish the candidate MCP's own internal HTTP request details.
 */
/**
 * Compare transport values, not metric validity or JSON runtime type.
 * Equal arbitrary strings (including "abc"), nulls or JSON values are valid matches.
 * For metric *values* (never identity keys), allow number/string representations
 * such as 25.5 and "25.5" / "25.50" with the configured numeric tolerance.
 */
export function equivalentValues(x, y, tolerance) {
    if (Object.is(x, y))
        return true;
    const numeric = (value) => {
        if (typeof value === 'number')
            return Number.isFinite(value) ? value : null;
        if (typeof value !== 'string' ||
            !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
            return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    };
    const a = numeric(x), b = numeric(y);
    if (a !== null && b !== null)
        return Math.abs(a - b) <= tolerance;
    return isDeepStrictEqual(x, y);
}
function visibleValue(v) {
    const raw = JSON.stringify(v);
    return (raw ?? String(v)).slice(0, 180);
}
export function keyOf(row, keys) {
    const parts = [];
    for (const k of keys) {
        if (!Object.hasOwn(row, k))
            return null;
        const value = row[k];
        if (value == null || value === '')
            return null;
        // JSON transport may stringify numeric IDs / epoch timestamps without
        // altering their textual identity. Preserve leading-zero string IDs.
        parts.push(typeof value === 'number' && Number.isFinite(value) ? String(value) : value);
    }
    return JSON.stringify(parts);
}
export function indexRows(rows, keys) {
    const map = new Map();
    let missing = 0;
    for (const [index, row] of rows.entries()) {
        const key = keyOf(row, keys);
        if (key === null) {
            missing++;
            continue;
        }
        const group = map.get(key) ?? [];
        group.push({ row, index });
        map.set(key, group);
    }
    return { map, missing };
}

export function keyStatistics(index, fields) {
    let groups = 0, rows = 0, additionalRows = 0, distinctMeasurements = 0;
    for (const group of index.map.values()) {
        if (group.length < 2) continue;
        groups++;
        rows += group.length;
        additionalRows += group.length - 1;
        const first = group[0].row;
        if (group.some(({ row }) => fields.some(field =>
            Object.hasOwn(first, field) !== Object.hasOwn(row, field) ||
            !equivalentValues(first[field], row[field], 0)))) distinctMeasurements++;
    }
    return { groups, rows, additionalRows, distinctMeasurements, missingKeys: index.missing };
}

export function checkRowKeys(reference, candidate) {
    const candidateInvalid = candidate.missing > 0;
    const referenceInvalid = reference?.missing > 0;
    const http = reference ? `식별자 누락=${reference.missing}` : '확인 불가';
    return {
        status: candidateInvalid ? 'FAIL' : referenceInvalid ? 'UNVERIFIABLE' : 'PASS',
        reason: candidateInvalid ? 'MCP_RECORD_IDENTITIES_INVALID' : referenceInvalid ? 'AMBIGUOUS_RECORD_IDENTITIES' : undefined,
        check: { code: 'MATCH_KEYS', ok: !candidateInvalid && !referenceInvalid,
            detail: `API ${http}; MCP 식별자 누락=${candidate.missing}` },
    };
}

// Find a maximum matching, reassigning previous pairs when a tolerance permits
// multiple candidates. Each reference row can be used only once.
function matchGroup(reference, candidate, compatible) {
    const edges = candidate.map(({ row }) => reference.flatMap((r, i) => compatible(r.row, row) ? [i] : []));
    const assigned = new Map();
    function assign(candidateIndex, visited) {
        const free = edges[candidateIndex].find(i => !visited.has(i) && !assigned.has(i));
        if (free !== undefined) {
            assigned.set(free, candidateIndex);
            return true;
        }
        for (const refIndex of edges[candidateIndex]) {
            if (visited.has(refIndex)) continue;
            visited.add(refIndex);
            if (assign(assigned.get(refIndex), visited)) {
                assigned.set(refIndex, candidateIndex);
                return true;
            }
        }
        return false;
    }
    for (const i of candidate.keys()) assign(i, new Set());
    return [...assigned].map(([i, j]) => [reference[i].index, candidate[j].index]);
}

export function compareRows(s, reference, candidate) {
    const keys = s.matchKeys ?? [];
    const fields = s.compareFields ?? [];
    if (!keys.length || !fields.length)
        return { status: 'UNVERIFIABLE', reason: 'COMPARISON_FIELDS_UNDEFINED', checks: [] };
    const a = indexRows(reference, keys), b = indexRows(candidate, keys);
    const identity = checkRowKeys(a, b);
    const checks = [identity.check];
    if (identity.status !== 'PASS') return { status: identity.status, reason: identity.reason, checks };

    const tolerance = s.absoluteTolerance ?? 0;
    const compatible = (x, y, allowAbsent) => fields.every(field => {
        const hasX = Object.hasOwn(x, field), hasY = Object.hasOwn(y, field);
        return hasX && hasY ? equivalentValues(x[field], y[field], tolerance) : allowAbsent && !hasX && !hasY;
    });
    const pairs = [], duplicateGroups = [];
    let httpOnly = 0, mcpOnly = 0, measurementMismatch = false, missingBoth = false;
    for (const key of new Set([...a.map.keys(), ...b.map.keys()])) {
        const left = a.map.get(key) ?? [], right = b.map.get(key) ?? [];
        httpOnly += Math.max(0, left.length - right.length);
        mcpOnly += Math.max(0, right.length - left.length);
        const strict = matchGroup(left, right, (x, y) => compatible(x, y, false));
        pairs.push(...strict);
        const expectedPairs = Math.min(left.length, right.length);
        let values = strict.length === expectedPairs ? 'MATCH' : 'MISMATCH';
        if (values === 'MISMATCH' && matchGroup(left, right, (x, y) => compatible(x, y, true)).length === expectedPairs)
            values = 'FIELDS_UNAVAILABLE';
        measurementMismatch ||= values === 'MISMATCH';
        missingBoth ||= values === 'FIELDS_UNAVAILABLE';
        if (left.length > 1 || right.length > 1)
            duplicateGroups.push({ key, httpRows: left.length, mcpRows: right.length, matchedRows: strict.length,
                values: expectedPairs === 0 ? 'NO_COUNTERPART' : values });
    }
    const comparison = { pairs, duplicateGroups, httpOnly, mcpOnly,
        http: keyStatistics(a, fields), mcp: keyStatistics(b, fields),
        sharedDuplicateKeys: duplicateGroups.filter(g => g.httpRows > 1 && g.mcpRows > 1).length };
    const sameCounts = !httpOnly && !mcpOnly;
    checks.push({ code: 'RECORD_IDENTITIES', ok: sameCounts,
        detail: `API ${reference.length}행 / MCP ${candidate.length}행; HTTP에만 ${httpOnly}행, MCP에만 ${mcpOnly}행` });
    const result = (status, reason) => ({ status, reason, checks, comparison });
    if (!sameCounts) return result('FAIL', 'MISSING_OR_EXTRA_RECORDS');
    checks.push({ code: 'FIELD_VALUES', ok: !measurementMismatch && !missingBoth,
        detail: `일대일 대응 ${pairs.length}/${reference.length}행` });
    if (measurementMismatch) return result('FAIL', 'FIELD_MISMATCH');
    if (missingBoth) return result('UNVERIFIABLE', 'COMPARISON_FIELD_ABSENT_IN_BOTH');
    return result('PASS', 'MATCHING_DATA');
}
