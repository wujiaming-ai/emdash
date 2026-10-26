import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { quoteArg } from '@emdash/core/primitives/exec/api';
import { PROTOCOL_VERSION } from '@emdash/core/workspace-server';
import { z } from 'zod';
import type { SshClientProxy } from '@core/primitives/ssh/api/node/ssh-client-proxy';
import { validateWorkspaceServerVersion } from '../layout';

const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z.object({
  version: z.string(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  installerSha256: checksum,
  artifacts: z.partialRecord(z.enum(['linux-x64', 'linux-arm64', 'darwin-arm64']), checksum),
});

export type BundledWorkspaceServer = {
  directory: string;
  manifest: z.infer<typeof manifestSchema>;
};

/** 只有未附带资源的官方构建使用在线渠道；损坏的定制包必须明确失败。 */
export async function readBundledWorkspaceServer(
  directory: string
): Promise<BundledWorkspaceServer | undefined> {
  try {
    await stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const content = await readFile(path.join(directory, 'manifest.json'), 'utf8');
  const manifest = manifestSchema.parse(JSON.parse(content));
  validateWorkspaceServerVersion(manifest.version);
  return { directory, manifest };
}

export async function installBundledWorkspaceServer(
  bundle: BundledWorkspaceServer,
  proxy: SshClientProxy,
  signal?: AbortSignal
): Promise<void> {
  const probe = await proxy.execScript('uname -s; uname -m', { signal, timeoutMs: 10_000 });
  if (probe.exitCode !== 0) throw new Error('Cannot determine bundled server target');
  const target = bundledTarget(probe.stdout);
  const sha256 = bundle.manifest.artifacts[target];
  if (!sha256) throw new Error(`No bundled workspace server for ${target}`);
  const archiveName = `emdash-workspace-server-${bundle.manifest.version}-${target}.tar.gz`;
  const archivePath = path.join(bundle.directory, archiveName);
  await verifyFile(archivePath, sha256, signal);
  const scriptPath = path.join(bundle.directory, 'install.sh');
  await verifyFile(scriptPath, bundle.manifest.installerSha256, signal);
  const script = await readFile(scriptPath, 'utf8');
  const stdin = createReadStream(archivePath);
  try {
    const result = await proxy.execScript(
      bundledInstallCommand(bundle.manifest.version, archiveName, sha256, script),
      { signal, stdin, timeoutMs: 300_000, maxStdoutBytes: 65_536, maxStderrBytes: 65_536 }
    );
    if (result.exitCode !== 0) {
      throw new Error(`Bundled workspace-server installation failed (exit ${result.exitCode})`);
    }
  } finally {
    stdin.destroy();
  }
}

function bundledTarget(output: string): keyof BundledWorkspaceServer['manifest']['artifacts'] {
  const [os, arch] = output.trim().split(/\s+/);
  if (os === 'Linux' && (arch === 'x86_64' || arch === 'amd64')) return 'linux-x64';
  if (os === 'Linux' && (arch === 'aarch64' || arch === 'arm64')) return 'linux-arm64';
  if (os === 'Darwin' && arch === 'arm64') return 'darwin-arm64';
  throw new Error('Unsupported bundled workspace-server platform');
}

async function verifyFile(file: string, expected: string, signal?: AbortSignal): Promise<void> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  if (hash.digest('hex') !== expected)
    throw new Error('Bundled workspace-server checksum mismatch');
}

/** 归档通过 SSH stdin 传输，复用官方安装器的锁、校验和原子切换。 */
export function bundledInstallCommand(
  version: string,
  archiveName: string,
  sha256: string,
  script: string
): string {
  validateWorkspaceServerVersion(version);
  if (!/^[a-zA-Z0-9.+-]+\.tar\.gz$/.test(archiveName) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Invalid bundled workspace-server artifact');
  }
  return `set -eu
umask 077
upload=$(mktemp -d /tmp/emdash-bundle.XXXXXXXX)
trap 'rm -rf -- "$upload"' EXIT HUP INT TERM
mkdir "$upload/${version}"
cat > "$upload/${version}/${archiveName}"
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\\n' ${quoteArg(sha256, 'posix')} "$upload/${version}/${archiveName}" | sha256sum -c - >/dev/null
else
  printf '%s  %s\\n' ${quoteArg(sha256, 'posix')} "$upload/${version}/${archiveName}" | shasum -a 256 -c - >/dev/null
fi
sh -c ${quoteArg(script, 'posix')} -- --base-url "file://$upload" --version ${quoteArg(version, 'posix')} --sha256 ${quoteArg(sha256, 'posix')}`;
}
