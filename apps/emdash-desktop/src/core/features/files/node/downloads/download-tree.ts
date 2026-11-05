import {
  decodeResourceUri,
  encodeResourceUri,
  type HostFileRef,
} from '@emdash/core/primitives/path/api';
import { type TransferEntry } from '@emdash/core/runtimes/files/api';
import type { LiveJobContext } from '@emdash/wire/live';
import type { DownloadConflict, DownloadProgress } from '../../api/downloads';
import { directoryEntries } from './directory-entries';
import { prepareDirectory, finishDirectory } from './directory-metadata';
import { downloadFile, type TransferClient } from './download-file';

export type DownloadTreeOptions = {
  destination: string;
  staging: string;
  conflict: DownloadConflict;
  sources: Array<{ uri: string; name: string }>;
  client: (ref: HostFileRef) => Promise<TransferClient>;
};

export async function downloadTree(
  options: DownloadTreeOptions,
  context: LiveJobContext<DownloadProgress>
): Promise<DownloadProgress> {
  const progress: DownloadProgress = {
    path: '',
    bytes: 0,
    size: 0,
    files: 0,
    transferred: 0,
    skipped: 0,
    warnings: [],
  };
  for (const source of options.sources) {
    context.signal.throwIfAborted();
    const parsed = decodeResourceUri(source.uri);
    if (!parsed.success) throw new Error(parsed.error.message);
    const client = await options.client(parsed.data);
    const info = await client.inspect(
      { path: parsed.data.path },
      { signal: context.signal, timeoutMs: 60_000 }
    );
    if (!info.success) throw new Error(`Cannot inspect source: ${JSON.stringify(info.error)}`);
    await visit(options, context, progress, client, parsed.data, info.data, source.name, 0);
  }
  return progress;
}

async function visit(
  options: DownloadTreeOptions,
  context: LiveJobContext<DownloadProgress>,
  progress: DownloadProgress,
  client: TransferClient,
  ref: HostFileRef,
  info: TransferEntry,
  relative: string,
  depth: number
): Promise<void> {
  context.signal.throwIfAborted();
  if (depth > 128) throw new Error('Directory nesting exceeds 128 levels');
  progress.path = relative;
  progress.bytes = 0;
  progress.size = info.size;
  context.progress({ ...progress });
  if (info.type === 'file') {
    let previous = 0;
    const result = await downloadFile({
      client,
      source: ref.path,
      identity: encodeResourceUri(ref),
      info,
      root: options.destination,
      relative,
      staging: options.staging,
      conflict: options.conflict,
      signal: context.signal,
      progress: (bytes) => {
        progress.transferred += bytes - previous;
        previous = bytes;
        progress.bytes = bytes;
        context.progress({ ...progress });
      },
    });
    if (result === 'skipped') progress.skipped++;
    else progress.files++;
  } else if (info.type === 'directory') {
    await downloadDirectory(options, context, progress, client, ref, info, relative, depth);
  } else {
    progress.skipped++;
    if (progress.warnings.length < 20)
      progress.warnings = [...progress.warnings, `Skipped ${info.type}: ${relative}`];
  }
  context.progress({ ...progress });
}

async function downloadDirectory(
  options: DownloadTreeOptions,
  context: LiveJobContext<DownloadProgress>,
  progress: DownloadProgress,
  client: TransferClient,
  ref: HostFileRef,
  info: TransferEntry,
  relative: string,
  depth: number
): Promise<void> {
  const directory = await prepareDirectory(options.destination, relative, options.staging);
  // 将每层清单暂存到磁盘；下载子文件时不占用远端目录流或保留整棵树。
  for await (const child of directoryEntries(client, ref, info, options.staging, context.signal)) {
    const childRef: HostFileRef = {
      host: ref.host,
      path: { ...ref.path, segments: [...ref.path.segments, child.name] },
    };
    await visit(
      options,
      context,
      progress,
      client,
      childRef,
      child,
      `${relative}/${child.name}`,
      depth + 1
    );
  }
  const after = await client.inspect(
    { path: ref.path },
    { signal: context.signal, timeoutMs: 60_000 }
  );
  if (!after.success || after.data.version !== info.version)
    throw new Error(`Directory changed during download: ${relative}`);
  await finishDirectory(directory, info);
}
