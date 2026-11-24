// Independent HTTP client. The MCP implementation and its internal requests are
// deliberately outside this adapter. The account lookup only supplies project tokens.
export class ReferenceApi {
  #projectTokens = new Map();

  constructor(accountToken, origin = 'https://api.whatap.io', fetchFn = fetch, signal) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash ||
        url.username || url.password) throw new Error('HTTP_ORIGIN_INVALID');
    this.origin = url.origin;
    this.accountToken = accountToken;
    this.fetch = fetchFn;
    this.signal = signal;
  }

  redact(text) {
    for (const token of [this.accountToken, ...this.#projectTokens.values()]) {
      if (token) text = text.replaceAll(token, '[REDACTED]');
    }
    return text;
  }

  async send(path, token, projectCode, payload) {
    const method = payload ? 'POST' : 'GET';
    const headers = { accept: 'application/json', 'x-whatap-token': token };
    if (projectCode) headers['x-whatap-pcode'] = String(projectCode);
    if (payload) headers['content-type'] = 'application/json';
    const timeout = AbortSignal.timeout(30_000);
    const response = await this.fetch(this.origin + path, {
      method, headers, redirect: 'error', signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body,
      request: { method, path, projectCode, payload } };
  }

  async connect(codes) {
    const { ok, status, body } = await this.send('/open-mcp/api/json/projects', this.accountToken);
    if (!ok) throw new Error('HTTP_PROJECT_LIST_' + status);
    const rows = Array.isArray(body) ? body : body?.data;
    if (!Array.isArray(rows)) throw new Error('HTTP_PROJECT_LIST_SCHEMA');
    for (const row of rows) {
      if (row?.projectCode && typeof row.apiToken === 'string' && row.apiToken) {
        this.#projectTokens.set(row.projectCode, row.apiToken);
      }
    }
    if (!codes.every(code => this.#projectTokens.has(code))) throw new Error('HTTP_PROJECT_ACCESS_UNAVAILABLE');
  }

  async stats(scenario, { stime, etime }) {
    const endpoint = scenario.statisticsMode === 'transaction' ? 'transaction' : 'error';
    const result = await this.send('/open/api/v2/stat/' + endpoint,
      this.#projectTokens.get(scenario.projectCode), scenario.projectCode, { stime, etime });
    return JSON.parse(this.redact(JSON.stringify(result)));
  }

  async mxql(scenario, { stime, etime }) {
    const stat = Boolean(scenario.statisticsMode);
    const path = stat ? '/open-mcp/api/flush/mxql/path' : '/open/api/flush/mxql/path';
    const mql = '/' + scenario.path.replace(/^mxql\//, '');
    const result = await this.send(path, this.#projectTokens.get(scenario.projectCode),
      scenario.projectCode, { pageKey: 'mxql', stime, etime, mql });
    return JSON.parse(this.redact(JSON.stringify(result)));
  }
}
