import { spawn, type ChildProcess } from 'node:child_process';
import { err, ok, type Result } from '@emdash/shared';
import { recordSpawn } from '@emdash/shared/perf';
import type { ShellEnvCaptureError } from './types';

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** 仅用于 POSIX 环境采集：异步、有界输出，失败时清理探测进程组。 */
export function probeShellEnv(
  shell: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<Result<string, ShellEnvCaptureError>> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      recordSpawn('shell', shell);
      child = spawn(shell, ['-ilc', 'env'], {
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(err({ type: 'capture-failed', shell, message: 'Could not start login shell' }));
      return;
    }
    collectProbe(child, shell, timeoutMs, resolve);
  });
}

function collectProbe(
  child: ChildProcess,
  shell: string,
  timeoutMs: number,
  resolve: (result: Result<string, ShellEnvCaptureError>) => void
): void {
  const stdout: Buffer[] = [];
  let settled = false;
  const finish = (result: Result<string, ShellEnvCaptureError>): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (!result.success && !stopProbe(child)) {
      result = err({ ...result.error, message: `${result.error.message}; probe cleanup failed` });
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    resolve(result);
  };
  const fail = (message: string): void => finish(err({ type: 'capture-failed', shell, message }));
  const timer = setTimeout(() => fail(`Timed out after ${timeoutMs}ms`), timeoutMs);
  child.stdout?.on(
    'data',
    boundedOutput('stdout', fail, (chunk) => stdout.push(chunk))
  );
  // 不保留启动脚本的 stderr；其中可能包含环境变量和密钥。
  child.stderr?.on('data', boundedOutput('stderr', fail));
  child.on('error', () => fail('Could not start login shell'));
  child.on('close', (code, signal) => {
    if (code === 0) finish(ok(Buffer.concat(stdout).toString('utf8')));
    else
      fail(
        signal
          ? `shell env capture terminated by ${signal}`
          : `shell env capture exited with status ${code}`
      );
  });
}

function boundedOutput(
  stream: 'stdout' | 'stderr',
  fail: (message: string) => void,
  append?: (chunk: Buffer) => void
): (chunk: Buffer) => void {
  let bytes = 0;
  return (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) fail(`${stream} exceeded maxBuffer`);
    else append?.(chunk);
  };
}

function stopProbe(child: ChildProcess): boolean {
  if (!child.pid) return true;
  try {
    // 即使 shell 已退出，仍清理继承输出管道的后台进程，保证超时有界。
    process.kill(-child.pid, 'SIGKILL');
    return true;
  } catch (error) {
    // 进程组正常退出与清理可能并发，ESRCH 表示已经没有待清理进程。
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
