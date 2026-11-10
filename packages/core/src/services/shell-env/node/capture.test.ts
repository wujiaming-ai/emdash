import { beforeEach, describe, expect, it, vi } from 'vitest';

const probeMock = vi.fn();
const existsSyncMock = vi.fn();
const userInfoMock = vi.fn();

vi.mock('./probe', () => ({ probeShellEnv: probeMock }));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}));

vi.mock('node:os', () => ({
  default: {
    userInfo: userInfoMock,
    homedir: () => '/home/test',
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  probeMock.mockReset();
});

const { captureShellEnv, parseEnvOutput, resolveLoginShell } = await import('./capture');

describe('parseEnvOutput', () => {
  it('parses shell env output and ignores invalid keys', () => {
    expect(parseEnvOutput('PATH=/usr/bin\nBAD-KEY=value\nFOO=a=b\n')).toEqual({
      PATH: '/usr/bin',
      FOO: 'a=b',
    });
  });
});

describe('resolveLoginShell', () => {
  it('falls back from SHELL to the account shell', () => {
    userInfoMock.mockReturnValueOnce({ shell: '/bin/fish' });
    existsSyncMock.mockImplementation((candidate) => candidate === '/bin/fish');

    expect(resolveLoginShell({ SHELL: '/missing' })).toBe('/bin/fish');
  });
});

describe('captureShellEnv', () => {
  it('captures login-shell env with guard variables', async () => {
    userInfoMock.mockReturnValueOnce({ shell: '/bin/bash' });
    existsSyncMock.mockReturnValue(true);
    probeMock.mockResolvedValueOnce({
      success: true,
      data:
        'PATH=/usr/local/bin:/usr/bin\nFOO=bar\nDISABLE_AUTO_UPDATE=true\n' +
        'ZSH_TMUX_AUTOSTART=false\nZSH_TMUX_AUTOSTARTED=true\n',
    });

    const result = await captureShellEnv({
      baseEnv: { SHELL: '/bin/bash', PATH: '/usr/bin' },
      now: () => 123,
    });

    expect(result).toEqual({
      success: true,
      data: {
        env: { PATH: '/usr/local/bin:/usr/bin', FOO: 'bar' },
        source: 'login-shell',
        capturedAt: 123,
      },
    });
    expect(probeMock).toHaveBeenCalledWith(
      '/bin/bash',
      expect.objectContaining({
        DISABLE_AUTO_UPDATE: 'true',
        ZSH_TMUX_AUTOSTART: 'false',
        ZSH_TMUX_AUTOSTARTED: 'true',
      }),
      15_000
    );
  });

  it('returns a capture error when the shell exits non-zero', async () => {
    userInfoMock.mockReturnValueOnce({ shell: '/bin/bash' });
    existsSyncMock.mockReturnValue(true);
    probeMock.mockResolvedValueOnce({
      success: false,
      error: {
        type: 'capture-failed',
        shell: '/bin/bash',
        message: 'shell env capture exited with status 2',
      },
    });

    const result = await captureShellEnv({ baseEnv: { SHELL: '/bin/bash' } });

    expect(result).toEqual({
      success: false,
      error: {
        type: 'capture-failed',
        shell: '/bin/bash',
        message: 'shell env capture exited with status 2',
      },
    });
  });
});

it('snapshots Windows without spawning a login shell', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  try {
    const result = await captureShellEnv({
      baseEnv: { Path: 'C:\\Windows', DISABLE_AUTO_UPDATE: 'true' },
    });
    expect(result).toMatchObject({
      success: true,
      data: { env: { Path: 'C:\\Windows' }, source: 'windows' },
    });
    expect(probeMock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
