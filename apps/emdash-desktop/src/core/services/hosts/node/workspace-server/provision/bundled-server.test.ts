import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION } from '@emdash/core/workspace-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SshClientProxy,
  SshExecOptions,
  SshExecResult,
} from '@core/primitives/ssh/api/node/ssh-client-proxy';
import {
  bundledInstallCommand,
  installBundledWorkspaceServer,
  readBundledWorkspaceServer,
  type BundledWorkspaceServer,
} from './bundled-server';

const directories: string[] = [];
const version = '0.1.11-pr.test';
const archive = `emdash-workspace-server-${version}-linux-x64.tar.gz`;
const digest = (content: string): string => createHash('sha256').update(content).digest('hex');
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<BundledWorkspaceServer> {
  const directory = await mkdtemp(path.join(tmpdir(), "emdash-bundle-test-'"));
  directories.push(directory);
  // 替身只替代最终安装器；SSH 输入、暂存、checksum 和参数解析均真实执行。
  const script = `set -eu
[ "$1" = --base-url ]
[ "$3" = --version ]
[ "$5" = --sha256 ]
cat "\${2#file://}/$4/emdash-workspace-server-$4-linux-x64.tar.gz" > "$HOME/received"
`;
  const manifest: BundledWorkspaceServer['manifest'] = {
    version,
    protocolVersion: PROTOCOL_VERSION,
    installerSha256: digest(script),
    artifacts: { 'linux-x64': digest('archive bytes') },
  };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, 'install.sh'), script);
  await writeFile(path.join(directory, archive), 'archive bytes');
  return { directory, manifest };
}

function shellProxy(home: string, platform = 'Linux\nx86_64\n'): SshClientProxy {
  const execScript = vi.fn(
    async (script: string, options?: SshExecOptions): Promise<SshExecResult> => {
      if (script === 'uname -s; uname -m') return { exitCode: 0, stdout: platform, stderr: '' };
      return new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', script], { env: { ...process.env, HOME: home } });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
        options?.stdin?.pipe(child.stdin);
      });
    }
  );
  return { execScript } as unknown as SshClientProxy;
}

describe('bundled workspace server', () => {
  it('loads valid metadata and transmits exact bytes through the real shell wrapper', async () => {
    const bundle = await fixture();
    expect(await readBundledWorkspaceServer(bundle.directory)).toEqual(bundle);
    await installBundledWorkspaceServer(bundle, shellProxy(bundle.directory));
    expect(await readFile(path.join(bundle.directory, 'received'), 'utf8')).toBe('archive bytes');
  });

  it('rejects corrupt archives before executing the installer', async () => {
    const bundle = await fixture();
    await writeFile(path.join(bundle.directory, archive), 'corrupted');
    const proxy = shellProxy(bundle.directory);
    await expect(installBundledWorkspaceServer(bundle, proxy)).rejects.toThrow('checksum');
    expect(proxy.execScript).toHaveBeenCalledTimes(1);
  });

  it('rejects corrupt installer scripts before uploading', async () => {
    const bundle = await fixture();
    await writeFile(path.join(bundle.directory, 'install.sh'), 'exit 0');
    const proxy = shellProxy(bundle.directory);
    await expect(installBundledWorkspaceServer(bundle, proxy)).rejects.toThrow('checksum');
    expect(proxy.execScript).toHaveBeenCalledTimes(1);
  });

  it('rejects absent target assets without falling back to a release download', async () => {
    const bundle = await fixture();
    const proxy = shellProxy(bundle.directory, 'Linux\naarch64\n');
    await expect(installBundledWorkspaceServer(bundle, proxy)).rejects.toThrow('No bundled');
    expect(proxy.execScript).toHaveBeenCalledTimes(1);
  });

  it('only allows absent resources, not malformed or missing manifests', async () => {
    const bundle = await fixture();
    expect(await readBundledWorkspaceServer(path.join(bundle.directory, 'absent'))).toBeUndefined();
    await writeFile(path.join(bundle.directory, 'manifest.json'), '{}');
    await expect(readBundledWorkspaceServer(bundle.directory)).rejects.toThrow();
    await rm(path.join(bundle.directory, 'manifest.json'));
    await expect(readBundledWorkspaceServer(bundle.directory)).rejects.toThrow();
  });

  it('rejects artifact path and version injection', () => {
    expect(() => bundledInstallCommand(version, '../bad.tar.gz', digest('x'), 'true')).toThrow();
    expect(() =>
      bundledInstallCommand('$(touch injected)', archive, digest('x'), 'true')
    ).toThrow();
  });
});
