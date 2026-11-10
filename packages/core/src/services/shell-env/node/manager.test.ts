import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CaptureModule from './capture';

const captureMock = vi.fn();
const existsSyncMock = vi.fn();
const userInfoMock = vi.fn();

vi.mock('./capture', async (importOriginal) => ({
  ...(await importOriginal<typeof CaptureModule>()),
  captureShellEnv: captureMock,
}));

const { parseEnvOutput } = await import('./capture');

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  statSync: vi.fn(() => ({ isDirectory: () => false })),
}));

vi.mock('node:os', () => ({
  default: {
    homedir: () => '/home/test',
    userInfo: userInfoMock,
  },
}));

const { createShellEnvManager } = await import('./manager');

beforeEach(() => {
  captureMock.mockReset();
  existsSyncMock.mockReset();
  userInfoMock.mockReset();
  userInfoMock.mockReturnValue({ shell: '/bin/bash' });
  existsSyncMock.mockReturnValue(true);
});

describe('createShellEnvManager', () => {
  it('starts and awaits the initial capture from current()', async () => {
    captureMock.mockReturnValue({
      success: true,
      data: {
        env: parseEnvOutput('PATH=/shell/bin\nFOO=initial\n'),
        source: 'login-shell',
        capturedAt: 0,
      },
    });
    const manager = createShellEnvManager({
      target: { PATH: '/worker/bin' },
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/worker/bin' }),
    });

    await expect(manager.current()).resolves.toMatchObject({
      FOO: 'initial',
      PATH: '/shell/bin:/worker/bin',
    });
    expect(captureMock).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent refreshes', async () => {
    captureMock.mockReturnValue({
      success: true,
      data: {
        env: parseEnvOutput('PATH=/usr/local/bin\nFOO=bar\n'),
        source: 'login-shell',
        capturedAt: 0,
      },
    });
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const manager = createShellEnvManager({
      target,
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/usr/bin' }),
    });

    await Promise.all([manager.refresh(), manager.refresh()]);

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(target.FOO).toBe('bar');
    expect(target.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(manager.getUserShellEnv()).toMatchObject({
      FOO: 'bar',
      PATH: '/usr/local/bin:/usr/bin',
    });
  });

  it('keeps runtime controls in the host env but excludes them from the user snapshot', async () => {
    captureMock.mockReturnValue({
      success: true,
      data: {
        env: parseEnvOutput('PATH=/shell/bin\nUSER_VALUE=kept\n'),
        source: 'login-shell',
        capturedAt: 0,
      },
    });
    const target: NodeJS.ProcessEnv = {
      PATH: '/worker/bin',
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '1',
    };
    const manager = createShellEnvManager({ target });

    await manager.refresh();

    expect(target.NODE_ENV).toBe('production');
    expect(target.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(manager.getUserShellEnv()).toEqual({
      PATH: '/shell/bin:/worker/bin',
      USER_VALUE: 'kept',
    });
  });

  it('preserves a runtime-named variable when the login shell explicitly exports it', async () => {
    captureMock.mockReturnValue({
      success: true,
      data: {
        env: parseEnvOutput('PATH=/shell/bin\nNODE_ENV=development\n'),
        source: 'login-shell',
        capturedAt: 0,
      },
    });
    const target: NodeJS.ProcessEnv = { PATH: '/worker/bin', NODE_ENV: 'production' };
    const manager = createShellEnvManager({ target });

    await manager.refresh();

    expect(target.NODE_ENV).toBe('production');
    expect(manager.getUserShellEnv().NODE_ENV).toBe('development');
  });

  it('retains the last snapshot until an in-flight refresh publishes atomically', async () => {
    captureMock.mockReturnValue({
      success: true,
      data: {
        env: parseEnvOutput('PATH=/tools/old\nUSER_VALUE=before-refresh\n'),
        source: 'login-shell',
        capturedAt: 0,
      },
    });
    const manager = createShellEnvManager({
      target: { PATH: '/worker/bin' },
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/worker/bin' }),
    });
    await manager.refresh();

    captureMock.mockReturnValue({
      success: true,
      data: {
        env: parseEnvOutput('PATH=/tools/new\nUSER_VALUE=after-refresh\n'),
        source: 'login-shell',
        capturedAt: 0,
      },
    });
    const refresh = manager.refresh();

    expect(manager.getUserShellEnv()).toMatchObject({
      PATH: '/tools/old:/worker/bin',
      USER_VALUE: 'before-refresh',
    });
    await expect(manager.current()).resolves.toMatchObject({
      PATH: '/tools/new:/worker/bin',
      USER_VALUE: 'after-refresh',
    });
    await refresh;
  });

  it('logs and keeps the existing env when capture fails', async () => {
    const warn = vi.fn();
    captureMock.mockReturnValue({
      success: false,
      error: { type: 'capture-failed', shell: '/bin/bash', message: 'spawn failed' },
    });
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const manager = createShellEnvManager({
      target,
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/probe/bin' }),
      logger: { warn },
    });

    await expect(manager.refresh()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      '[shell-env] Failed to resolve login-shell env',
      expect.objectContaining({ shell: '/bin/bash', error: 'spawn failed' })
    );
    expect(target).toEqual({ PATH: '/usr/bin' });
    await expect(manager.current()).resolves.toEqual({
      PATH: '/probe/bin',
      SHELL: '/bin/bash',
    });
  });

  it('retains the last known-good snapshot when a later refresh fails', async () => {
    captureMock.mockReturnValue({
      success: true,
      data: {
        env: parseEnvOutput('PATH=/tools/good\nUSER_VALUE=known-good\n'),
        source: 'login-shell',
        capturedAt: 0,
      },
    });
    const manager = createShellEnvManager({
      target: { PATH: '/worker/bin' },
      baseEnvForProbe: () => ({ SHELL: '/bin/bash', PATH: '/worker/bin' }),
    });
    await manager.refresh();

    captureMock.mockReturnValue({
      success: false,
      error: { type: 'capture-failed', shell: '/bin/bash', message: 'refresh failed' },
    });
    await manager.refresh();

    await expect(manager.current()).resolves.toMatchObject({
      PATH: '/tools/good:/worker/bin',
      USER_VALUE: 'known-good',
    });
  });
});

// 首次失败后应限频恢复，不能永久停留在 GUI 的精简 PATH。
it('retries a failed initial capture on demand after the cooldown', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
  captureMock.mockReturnValue({
    success: false,
    error: { type: 'capture-failed', shell: '/bin/bash', message: 'timeout' },
  });
  const manager = createShellEnvManager({ target: { PATH: '/usr/bin' } });
  try {
    await manager.current();
    clock.mockReturnValue(4_999);
    await manager.current();
    expect(captureMock).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(5_000);
    captureMock.mockReturnValue({
      success: true,
      data: { env: { PATH: '/opt/homebrew/bin' }, source: 'login-shell', capturedAt: 0 },
    });
    const results = await Promise.all([manager.current(), manager.current()]);
    expect(results[0].PATH).toBe('/opt/homebrew/bin:/usr/bin');
    expect(results[1]).toEqual(results[0]);
    expect(captureMock).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
  }
});

it('allows explicit refresh to recover immediately without waiting for the cooldown', async () => {
  captureMock.mockResolvedValueOnce({ success: false, error: { message: 'timeout' } });
  const manager = createShellEnvManager({ target: { PATH: '/usr/bin' } });
  await manager.current();
  captureMock.mockResolvedValueOnce({
    success: true,
    data: { env: { PATH: '/recovered/bin' }, source: 'login-shell', capturedAt: 0 },
  });
  await manager.refresh();
  expect((await manager.current()).PATH).toBe('/recovered/bin:/usr/bin');
  expect(captureMock).toHaveBeenCalledTimes(2);
});
