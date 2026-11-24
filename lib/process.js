import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// File descriptors preserve child output on hosts where nested npm commands
// cannot inherit piped stdout. Temporary files are removed after every command.
export async function command(program, args, {
  cwd, env, input, timeout = 60_000, maxBytes = 16_000_000,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wpr-command-'));
  const stdoutPath = join(directory, 'out');
  const stderrPath = join(directory, 'err');
  let stdout;
  let stderr;
  try {
    stdout = await open(stdoutPath, 'w+', 0o600);
    stderr = await open(stderrPath, 'w+', 0o600);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd, env, detached: true, stdio: ['pipe', stdout.fd, stderr.fd] });
      let problem;
      function stop(reason) {
        problem ??= reason;
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') reject(error); }
        }
      }
      const timeoutId = setTimeout(() => stop('TIMEOUT'), timeout);
      const watchSize = setInterval(async () => {
        try {
          const [out, err] = await Promise.all([stat(stdoutPath), stat(stderrPath)]);
          if (out.size + err.size > maxBytes) stop('OUTPUT_LIMIT');
        } catch (error) { if (error.code !== 'ENOENT') stop('OUTPUT_STAT'); }
      }, 500);
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop('STDIN_ERROR'); });
      child.once('error', error => { problem ??= String(error.code ?? 'SPAWN_ERROR'); });
      child.once('close', (code, signal) => {
        clearTimeout(timeoutId);
        clearInterval(watchSize);
        resolve({ code, signal, problem });
      });
      child.stdin.end(input);
    });
    const [out, err] = await Promise.all([stdout.stat(), stderr.stat()]);
    if (out.size + err.size > maxBytes) return { ...result, problem: 'OUTPUT_LIMIT', stdout: '', stderr: '' };
    return { ...result, stdout: await readFile(stdoutPath, 'utf8'), stderr: await readFile(stderrPath, 'utf8') };
  } finally {
    await stdout?.close();
    await stderr?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
