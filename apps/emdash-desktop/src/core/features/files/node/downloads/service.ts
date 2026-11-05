import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { hostRefEquals } from '@emdash/core/primitives/host/api';
import { decodeResourceUri, type ResourceUri } from '@emdash/core/primitives/path/api';
import { err, ok, type Result } from '@emdash/shared';
import type { LiveJobContext } from '@emdash/wire/live';
import { WireError } from '@emdash/wire/rpc';
import { z } from 'zod';
import type { DownloadConflict, DownloadProgress } from '../../api/downloads';
import type { FilesRuntimeBroker } from '../wire-controller';
import { downloadTree, type DownloadTreeOptions } from './download-tree';
import { optionalStat, readJson, safeName, writeJson } from './local-files';
import { lockDownload } from './lock';

const planSchema = z.object({
  identity: z.string(),
  sources: z.array(z.object({ uri: z.string(), name: z.string() })),
});
type Session = { options: DownloadTreeOptions; running?: Promise<DownloadProgress> };
export type DownloadServiceOptions = {
  runtimes: FilesRuntimeBroker;
  chooseDirectory?: () => Promise<string | undefined>;
};

export class FileDownloads {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly dependencies: DownloadServiceOptions) {}

  async prepare(input: {
    sources: ResourceUri[];
    conflict: DownloadConflict;
  }): Promise<{ id: string; destination: string } | null> {
    if (!this.dependencies.chooseDirectory) throw new Error('Local download dialog is unavailable');
    const selected = await this.dependencies.chooseDirectory();
    if (!selected) return null;
    const destination = await realpath(selected);
    const sources = normalizeSources(input.sources);
    const identity = JSON.stringify([sources, input.conflict]);
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 24);
    const staging = path.join(destination, `.emdash-download-${key}`);
    if (
      [...this.sessions.values()].some(
        (session) => session.running && session.options.staging === staging
      )
    )
      throw new Error('This download is already running');
    await ensureStaging(staging);
    const planFile = path.join(staging, 'plan.json');
    const plan = (await optionalStat(planFile))
      ? planSchema.parse(await readJson(planFile))
      : { identity, sources: await chooseNames(sources, destination, input.conflict) };
    if (plan.identity !== identity)
      throw new Error('Download checkpoint does not match these sources');
    await writeJson(planFile, plan);
    const id = randomUUID();
    this.sessions.set(id, {
      options: {
        destination,
        staging,
        conflict: input.conflict,
        sources: plan.sources,
        client: async (ref) => {
          const runtime = await this.dependencies.runtimes.client(ref.host);
          if (!runtime.success)
            throw new Error(`Remote is unavailable: ${JSON.stringify(runtime.error)}`);
          return runtime.data.files.transfer;
        },
      },
    });
    return { id, destination };
  }

  async run(
    id: string,
    context: LiveJobContext<DownloadProgress>
  ): Promise<Result<DownloadProgress, { message: string }>> {
    const session = this.session(id);
    if (
      session.running ||
      [...this.sessions.values()].some(
        (other) =>
          other !== session && other.running && other.options.staging === session.options.staging
      )
    )
      return err({ message: 'This download is already running' });
    const running = this.execute(session, context);
    session.running = running;
    try {
      const result = await running;
      this.sessions.delete(id);
      return ok(result);
    } catch (error) {
      return err({
        message:
          error instanceof WireError && error.code === 'NOT_FOUND'
            ? 'This remote Emdash service does not support downloads yet. Update the remote service and retry.'
            : error instanceof Error
              ? error.message
              : String(error),
      });
    } finally {
      session.running = undefined;
    }
  }

  private async execute(
    session: Session,
    context: LiveJobContext<DownloadProgress>
  ): Promise<DownloadProgress> {
    const unlock = await lockDownload(session.options.staging);
    let removed = false;
    try {
      const result = await downloadTree(session.options, context);
      await removeStaging(session.options.staging);
      removed = true;
      return result;
    } finally {
      if (!removed) await unlock();
    }
  }

  async discard(id: string): Promise<void> {
    const session = this.session(id);
    // 取消后的失败已由任务结果呈现；等待写入退出后才能清理临时文件。
    await session.running?.then(
      () => undefined,
      () => undefined
    );
    const unlock = await lockDownload(session.options.staging);
    try {
      await removeStaging(session.options.staging);
    } catch (error) {
      await unlock();
      throw error;
    }
    this.sessions.delete(id);
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session)
      throw new Error('Download session expired; select the same destination to resume');
    return session;
  }
}

async function chooseNames(
  sources: ResourceUri[],
  destination: string,
  conflict: DownloadConflict
): Promise<Array<{ uri: string; name: string }>> {
  const names = new Set<string>();
  const chosen: Array<{ uri: string; name: string }> = [];
  for (const uri of sources) {
    const parsed = decodeResourceUri(uri);
    if (!parsed.success) throw new Error(parsed.error.message);
    const base = safeName(parsed.data.path.segments.at(-1) ?? 'root');
    let name = base;
    for (
      let suffix = 1;
      names.has(name.normalize('NFC').toLowerCase()) ||
      (conflict === 'keep-both' && (await optionalStat(path.join(destination, name))));
      suffix++
    )
      name = `${base} (${suffix})`;
    names.add(name.normalize('NFC').toLowerCase());
    chosen.push({ uri, name });
  }
  return chosen;
}

async function removeStaging(staging: string): Promise<void> {
  // 先移走整个私有目录，避免删除锁文件后另一进程进入正在清理的目录。
  const removed = `${staging}.cleanup-${randomUUID()}`;
  await rename(staging, removed);
  await rm(removed, { recursive: true });
}

async function ensureStaging(staging: string): Promise<void> {
  await mkdir(staging, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await lstat(staging);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Unsafe download staging directory');
}

function normalizeSources(sources: ResourceUri[]): ResourceUri[] {
  const parsed = [...new Set(sources)].sort().map((uri) => {
    const ref = decodeResourceUri(uri);
    if (!ref.success) throw new Error(ref.error.message);
    return { uri, ref: ref.data };
  });
  return parsed
    .filter(
      (item) =>
        !parsed.some(
          (parent) =>
            parent !== item &&
            hostRefEquals(parent.ref.host, item.ref.host) &&
            JSON.stringify(parent.ref.path.root) === JSON.stringify(item.ref.path.root) &&
            parent.ref.path.segments.length < item.ref.path.segments.length &&
            parent.ref.path.segments.every(
              (segment, index) => segment === item.ref.path.segments[index]
            )
        )
    )
    .map((item) => item.uri);
}
