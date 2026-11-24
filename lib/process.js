import { spawn } from 'node:child_process';

// A process group lets the timeout cover subprocesses such as npm, Vitest and Codex.
export function command(program, args, { cwd, env, input, timeout = 60_000, maxBytes = 16_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let problem;
    let bytes = 0;
    const stdout = [];
    const stderr = [];
    function stop(reason) {
      problem ??= reason;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') reject(error); }
      }
    }
    const timer = setTimeout(() => stop('TIMEOUT'), timeout);
    function collect(target, chunk) {
      bytes += chunk.length;
      if (bytes > maxBytes) stop('OUTPUT_LIMIT');
      else target.push(chunk);
    }
    child.stdout.on('data', chunk => collect(stdout, chunk));
    child.stderr.on('data', chunk => collect(stderr, chunk));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop('STDIN_ERROR'); });
    child.once('error', error => { problem ??= String(error.code ?? 'SPAWN_ERROR'); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, problem, stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(input);
  });
}
