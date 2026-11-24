import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { dirname } from 'node:path';
/**
 * Narrow JSON-RPC stdio adapter for read-only tools/list and tools/call.
 * No SDK needed for this phase. Later versions can replace this transport with
 * the official MCP client SDK without changing the validation logic.
 * No output size cap: entire JSON-RPC messages are parsed, including >1 MB.
 */
export class StdioMcpClient {
    entry;
    timeoutMs;
    child;
    pending = new Map();
    nextId = 1;
    buffer = '';
    decoder = new StringDecoder('utf8');
    stderrTail = '';
    failure;
    constructor(entry, timeoutMs, env) {
        this.entry = entry;
        this.timeoutMs = timeoutMs;
        this.env = env;
    }
    dead(error) {
        if (!this.failure)
            this.failure = error;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(this.failure);
        }
        this.pending.clear();
    }
    receive(message) {
        if (typeof message.id !== 'number')
            return; // notification / other server request
        const p = this.pending.get(message.id);
        if (!p)
            return;
        this.pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error)
            p.reject(new Error(`MCP RPC ${message.error.code}: ${message.error.message}`));
        else
            p.resolve(message.result);
    }
    onData(chunk) {
        this.buffer += this.decoder.write(chunk);
        while (true) {
            const i = this.buffer.indexOf('\n');
            if (i < 0)
                break;
            const line = this.buffer.slice(0, i).trim();
            this.buffer = this.buffer.slice(i + 1);
            if (!line)
                continue;
            try {
                this.receive(JSON.parse(line));
            }
            catch {
                this.dead(new Error('Malformed MCP JSON-RPC response on stdout'));
                return;
            }
        }
    }
    async start() {
        if (this.child)
            throw new Error('MCP client already started');
        this.child = spawn(process.execPath, [this.entry], {
            cwd: dirname(this.entry),
            env: this.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
        });
        this.child.stdout.on('data', (chunk) => this.onData(chunk));
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', (value) => { this.stderrTail = (this.stderrTail + value).slice(-8192); });
        this.child.on('error', (error) => this.dead(error));
        this.child.stdin.on('error', (error) => this.dead(error));
        this.child.on('exit', (code, signal) => {
            this.dead(new Error(`MCP process terminated (exit=${code}, signal=${signal})`));
        });
        const result = await this.call('initialize', {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'whatap-validation-harness', version: '0.3.0' },
        });
        if (!result || !result.protocolVersion)
            throw new Error('MCP initialize missing protocolVersion');
        this.notify('notifications/initialized');
    }
    notify(method, params) {
        if (!this.child || this.failure)
            throw this.failure ?? new Error('MCP client not running');
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
    }
    call(method, params = {}) {
        if (!this.child || this.failure)
            return Promise.reject(this.failure ?? new Error('MCP client not running'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
            this.child.stdin.write(message, err => {
                if (err) {
                    const entry = this.pending.get(id);
                    if (entry) {
                        clearTimeout(entry.timer);
                        this.pending.delete(id);
                        reject(err);
                    }
                }
            });
        });
    }
    async listTools() {
        const tools = [];
        let cursor;
        const seen = new Set();
        do {
            const result = await this.call('tools/list', cursor ? { cursor } : {});
            if (!result || !Array.isArray(result.tools))
                throw new Error('tools/list returned no tools array');
            tools.push(...result.tools);
            cursor = result.nextCursor;
            if (cursor) {
                if (seen.size >= 100 || seen.has(cursor))
                    throw new Error('MCP tools/list pagination loop');
                seen.add(cursor);
            }
        } while (cursor);
        return tools;
    }
    async callTool(name, args) {
        const result = await this.call('tools/call', { name, arguments: args });
        if (!result || typeof result !== 'object')
            throw new Error(`Invalid tools/call result for ${name}`);
        return result;
    }
    stderrHint() { return this.stderrTail; }
    async close() {
        if (!this.child)
            return;
        const child = this.child;
        this.child = undefined;
        this.dead(new Error('MCP client closed'));
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (child.exitCode !== null || child.signalCode !== null)
            return;
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        timer.unref();
        child.once('exit', () => clearTimeout(timer));
        child.kill('SIGTERM');
    }
}
