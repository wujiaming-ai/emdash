import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureShellEnv } from './capture';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixtureShell(script: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shell-capture-'));
  directories.push(dir);
  const shell = path.join(dir, 'shell');
  await writeFile(shell, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  return shell;
}

describe.skipIf(process.platform === 'win32')('shell capture process boundary', () => {
  it('allows the event loop to progress while the shell initializes', async () => {
    const shell = await fixtureShell('/bin/sleep 0.2\nprintf "PATH=/tools/bin\\n"');
    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
    }, 0);
    try {
      const result = await captureShellEnv({ baseEnv: { SHELL: shell, PATH: '/usr/bin' } });
      expect(result.success && result.data.env.PATH).toBe('/tools/bin');
      expect(ticked).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });
  it('provides EOF when shell startup tries to read standard input', async () => {
    const shell = await fixtureShell('read ignored\nprintf "PATH=/tools/bin\\n"');
    const result = await captureShellEnv({ baseEnv: { SHELL: shell }, timeoutMs: 2_000 });
    expect(result.success && result.data.env.PATH).toBe('/tools/bin');
  });

  it('accepts startup taking longer than the previous five-second limit', async () => {
    const shell = await fixtureShell('/bin/sleep 5.2\nprintf "PATH=/slow/tools\\n"');
    const result = await captureShellEnv({ baseEnv: { SHELL: shell } });
    expect(result.success && result.data.env.PATH).toBe('/slow/tools');
  }, 10_000);

  it('times out and terminates the probe child process group', async () => {
    const shell = await fixtureShell('/bin/sleep 60 &\necho $! > "$HOME/child.pid"\nwait');
    const result = await captureShellEnv({
      baseEnv: { SHELL: shell, HOME: path.dirname(shell) },
      timeoutMs: 2_000,
    });
    expect(result).toMatchObject({ success: false, error: { message: 'Timed out after 2000ms' } });
    const pid = Number(await readFile(path.join(path.dirname(shell), 'child.pid'), 'utf8'));
    await expect.poll(() => processExists(pid)).toBe(false);
  });

  it('terminates descendants even after the shell exits with an open output pipe', async () => {
    const shell = await fixtureShell('/bin/sleep 60 &\necho $! > "$HOME/child.pid"\nexit 0');
    const result = await captureShellEnv({
      baseEnv: { SHELL: shell, HOME: path.dirname(shell) },
      timeoutMs: 2_000,
    });
    expect(result).toMatchObject({ success: false, error: { message: 'Timed out after 2000ms' } });
    const pid = Number(await readFile(path.join(path.dirname(shell), 'child.pid'), 'utf8'));
    await expect.poll(() => processExists(pid)).toBe(false);
  });

  it('does not expose partial environment or startup diagnostics on nonzero exit', async () => {
    const shell = await fixtureShell(
      'printf "PRIVATE_VALUE=fixture-only\\n"\nprintf "fixture-only" >&2\nexit 2'
    );
    const result = await captureShellEnv({ baseEnv: { SHELL: shell } });
    expect(result).toMatchObject({
      success: false,
      error: { message: 'shell env capture exited with status 2' },
    });
    expect(JSON.stringify(result)).not.toContain('fixture-only');
  });

  it('rejects a shell terminated by a signal', async () => {
    const shell = await fixtureShell('kill -TERM $$');
    const result = await captureShellEnv({ baseEnv: { SHELL: shell } });
    expect(result).toMatchObject({
      success: false,
      error: { message: 'shell env capture terminated by SIGTERM' },
    });
  });

  it.each(['stdout', 'stderr'])(
    'rejects oversized %s without publishing partial environment',
    async (stream) => {
      const redirect = stream === 'stderr' ? ' >&2' : '';
      const shell = await fixtureShell(
        `printf 'PATH=/partial\\n'\n/usr/bin/head -c 1048577 /dev/zero${redirect}`
      );
      const result = await captureShellEnv({ baseEnv: { SHELL: shell } });
      expect(result).toMatchObject({
        success: false,
        error: { message: `${stream} exceeded maxBuffer` },
      });
    }
  );

  it('reports a process that cannot be started without leaking partial output', async () => {
    const shell = await fixtureShell('exit 0');
    await writeFile(shell, '#!/nonexistent/interpreter\n');
    const result = await captureShellEnv({ baseEnv: { SHELL: shell } });
    expect(result).toMatchObject({
      success: false,
      error: { message: 'Could not start login shell' },
    });
  });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
