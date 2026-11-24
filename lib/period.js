const DATE = '(\\d{4}-\\d{2}-\\d{2})';
const CLOCK = '(\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d{3}))?';
const LEGACY_TIME = DATE + '[ T]' + CLOCK + ' UTC';
const PERIOD_TIME = '(?:' + LEGACY_TIME + '|' + DATE + 'T' + CLOCK + 'Z)';
const PERIOD_RE = new RegExp('\\*\\*Period\\*\\*:\\s*' + PERIOD_TIME +
    '\\s*(?:→|->|to)\\s*' + PERIOD_TIME + '(?=\\s|$)', 'i');
const CELL_TIME_RE = new RegExp('^' + LEGACY_TIME + '$');
function utcMillis(date, time, millis = 0) {
    const d = Date.parse(`${date}T${time}Z`);
    if (!Number.isFinite(d) || new Date(d).toISOString().slice(0, 19) !== `${date}T${time}`)
        return null;
    return d + Number(millis);
}
export function parseMcpPeriod(text) {
    const m = PERIOD_RE.exec(text);
    if (!m || PERIOD_RE.test(text.slice(m.index + m[0].length)))
        return null;
    const stime = utcMillis(m[1] ?? m[4], m[2] ?? m[5], m[3] ?? m[6]);
    const etime = utcMillis(m[7] ?? m[10], m[8] ?? m[11], m[9] ?? m[12]);
    if (stime === null || etime === null || etime <= stime)
        return null;
    return { label: m[0], stime, etime };
}
function splitCells(line) {
    if (!/^\s*\|/.test(line) || !/\|\s*$/.test(line))
        return [];
    return line.trim().slice(1, -1).split(/(?<!\\)\|/).map(v => v.trim().replace(/\\\|/g, '|'));
}
function unwrapHeader(c) {
    return c.replace(/\s+\((?:%|ms|bytes)\)$/i, '').replace(/`/g, '');
}
function decodeCell(raw, column) {
    if (column === 'time') {
        const m = CELL_TIME_RE.exec(raw);
        if (m)
            return utcMillis(m[1], m[2], m[3]);
        if (/^\d{13}$/.test(raw))
            return Number(raw);
        return raw; // explicitly fail later if the timestamp is not interpretable
    }
    // '-' may represent null or a literal dash: compare what the MCP visibly prints.
    return raw; // identity and values are normalized by compareRows, not by parser
}
/**
 * Strictly parse the *data table* of whatap_query_data; never treat summaries/guide tables as data.
 * Reject ambiguous tables, missing keys, partially parsed rows and repeated headers.
 */
export function parseFormattedMcp(text, required) {
    const period = parseMcpPeriod(text);
    if (!period)
        return { ok: false, reason: 'MCP_PERIOD_MISSING_OR_INVALID' };
    const lines = text.split(/\r?\n/);
    const candidates = [];
    for (let i = 0; i < lines.length - 1; i++) {
        const cols = splitCells(lines[i]).map(unwrapHeader);
        if (!cols.includes('time') || !required.every(k => cols.includes(k)))
            continue;
        const sep = splitCells(lines[i + 1]);
        if (sep.length !== cols.length || !sep.every(v => /^:?-{3,}:?$/.test(v)))
            continue;
        candidates.push({ index: i, columns: cols });
    }
    if (candidates.length !== 1)
        return { ok: false, reason: 'MCP_DATA_TABLE_MISSING_OR_AMBIGUOUS' };
    const { index, columns } = candidates[0];
    if (new Set(columns).size !== columns.length)
        return { ok: false, reason: 'MCP_DUPLICATED_TABLE_COLUMNS' };
    const rows = [];
    for (let i = index + 2; i < lines.length; i++) {
        if (!/^\s*\|/.test(lines[i]))
            break;
        const cells = splitCells(lines[i]);
        if (cells.length !== columns.length)
            return { ok: false, reason: 'MCP_TABLE_ROW_WIDTH_INVALID' };
        const row = Object.create(null);
        for (let j = 0; j < columns.length; j++)
            row[columns[j]] = decodeCell(cells[j], columns[j]);
        if (typeof row.time !== 'number' || !Number.isSafeInteger(row.time))
            return { ok: false, reason: 'MCP_TABLE_TIMESTAMP_INVALID' };
        rows.push(row);
    }
    if (!rows.length)
        return { ok: false, reason: 'MCP_TABLE_NO_ROWS' };
    const truncated = /Result may be truncated|Showing\s+\d+\s+rows[^\n]*truncated|result may be truncated/i.test(text);
    return { ok: true, data: { period, rows, columns, truncated } };
}
/** When a value is displayed by formatValue(), non-integers are rounded to two decimals. */
export function forMcpDisplay(reference, fields) {
    return reference.map(row => {
        const result = { ...row };
        for (const field of fields) {
            const value = row[field];
            if (value === null)
                result[field] = '-';
            else if (typeof value === 'number' && !Number.isInteger(value))
                result[field] = Number(value.toFixed(2));
        }
        return result;
    });
}
export function expectedDurationMs(expr) {
    const normalized = expr.trim().toLowerCase();
    const m = /^(\d+)\s*([smhdw])$/.exec(normalized) ??
        /^(?:last\s+)?(\d+)\s+(second|minute|hour|day|week)s?$/.exec(normalized);
    if (!m)
        return null;
    const duration = Number(m[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2][0]] ?? 0);
    return Number.isSafeInteger(duration) && duration > 0 ? duration : null;
}
