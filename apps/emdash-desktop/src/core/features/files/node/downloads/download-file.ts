import { createHash, type Hash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  type lstat,
  open,
  rename,
  unlink,
  utimes,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import type { HostAbsolutePath } from '@emdash/core/primitives/path/api';
import {
  TRANSFER_BLOCK_BYTES,
  type TransferEntry,
  type fileTransferContract,
} from '@emdash/core/runtimes/files/api';
import type { ContractClient } from '@emdash/wire/rpc';
import { z } from 'zod';
import type { DownloadConflict } from '../../api/downloads';
import {
  optionalStat,
  readJson,
  safeDirectory,
  safeName,
  writeAll,
  writeJson,
} from './local-files';

export type TransferClient = ContractClient<typeof fileTransferContract>;
const checkpointSchema = z.object({
  version: z.string(),
  target: z.string(),
  size: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().safe(),
  prefixSha256: z.string().regex(/^[a-f0-9]{64}$/),
  complete: z.boolean(),
  original: z.string().nullable(),
});
type Checkpoint = z.infer<typeof checkpointSchema>;
export type DownloadFileInput = {
  client: TransferClient;
  source: HostAbsolutePath;
  identity: string;
  info: TransferEntry;
  root: string;
  relative: string;
  staging: string;
  conflict: DownloadConflict;
  signal: AbortSignal;
  progress: (bytes: number) => void;
};
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const stamp = (info: Awaited<ReturnType<typeof lstat>>): string =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

export async function downloadFile(input: DownloadFileInput): Promise<'downloaded' | 'skipped'> {
  const key = sha(Buffer.from(input.identity));
  const statePath = path.join(input.staging, `${key}.json`);
  const partial = path.join(input.staging, `${key}.part`);
  await safeDirectory(
    input.root,
    path.posix.dirname(input.relative) === '.' ? '' : path.posix.dirname(input.relative)
  );
  const state = await loadCheckpoint(input, statePath);
  if (!state) return 'skipped';
  if (state.version !== input.info.version || state.size !== input.info.size)
    throw new Error(`Source changed: ${input.relative}. Discard partial download and restart.`);
  const destination = path.join(input.root, ...state.target.split('/').map(safeName));
  if (await committedFile(input, state, partial, destination)) {
    state.complete = true;
    await writeJson(statePath, state);
    input.progress(state.size);
    return 'downloaded';
  }
  await receiveFile(input, state, partial, statePath);
  input.signal.throwIfAborted();
  await finishFile(input, state, partial, destination);
  state.complete = true;
  await writeJson(statePath, state);
  return 'downloaded';
}

async function committedFile(
  input: DownloadFileInput,
  state: Checkpoint,
  partial: string,
  destination: string
): Promise<boolean> {
  const completeHashes = state.offset === state.size;
  if (!state.complete && (!completeHashes || (await optionalStat(partial)))) return false;
  const info = await optionalStat(destination);
  if (!state.complete && (!info || (state.original && stamp(info) === state.original)))
    return false;
  const handle = await open(
    destination,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Invalid completed download');
    await verifyPrefix(handle, { ...state, complete: true }, input.signal);
  } finally {
    await handle.close();
  }
  return true;
}

async function receiveFile(
  input: DownloadFileInput,
  state: Checkpoint,
  partial: string,
  statePath: string
): Promise<void> {
  const handle = await open(
    partial,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Invalid partial file');
    const hash = await verifyPrefix(handle, state, input.signal);
    await handle.truncate(state.offset);
    await receiveBlocks(input, state, handle, statePath, hash);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function loadCheckpoint(
  input: DownloadFileInput,
  statePath: string
): Promise<Checkpoint | undefined> {
  if (await optionalStat(statePath)) return checkpointSchema.parse(await readJson(statePath));
  const requested = path.join(input.root, ...input.relative.split('/').map(safeName));
  let target = input.relative;
  let existing = await optionalStat(requested);
  if (existing && input.conflict === 'skip') return undefined;
  if (existing && input.conflict === 'keep-both') {
    const ext = path.posix.extname(target);
    const stem = ext ? target.slice(0, -ext.length) : target;
    for (let count = 1; existing; count++) {
      target = `${stem} (${count})${ext}`;
      existing = await optionalStat(path.join(input.root, target));
    }
  }
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(`Refusing to replace non-regular file: ${requested}`);
  const state: Checkpoint = {
    version: input.info.version,
    target,
    size: input.info.size,
    offset: 0,
    prefixSha256: sha(Buffer.alloc(0)),
    complete: false,
    original: existing ? stamp(existing) : null,
  };
  await writeJson(statePath, state);
  return state;
}

async function verifyPrefix(
  handle: FileHandle,
  state: Checkpoint,
  signal: AbortSignal
): Promise<Hash> {
  if (state.offset > state.size) throw new Error('Invalid checkpoint offset');
  const hash = createHash('sha256');
  let offset = 0;
  const buffer = Buffer.alloc(TRANSFER_BLOCK_BYTES);
  while (offset < state.offset) {
    signal.throwIfAborted();
    const length = Math.min(TRANSFER_BLOCK_BYTES, state.offset - offset);
    if (length <= 0) throw new Error('Invalid checkpoint length');
    let read = 0;
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, offset + read);
      if (!result.bytesRead)
        throw new Error('Partial download is truncated; discard it and restart');
      read += result.bytesRead;
    }
    hash.update(buffer.subarray(0, length));
    offset += length;
  }
  if (hash.copy().digest('hex') !== state.prefixSha256)
    throw new Error('Partial download checksum mismatch; discard it and restart');
  if (state.complete && (offset !== state.size || (await handle.stat()).size !== state.size))
    throw new Error('Completed download changed');
  return hash;
}

async function receiveBlocks(
  input: DownloadFileInput,
  state: Checkpoint,
  handle: FileHandle,
  statePath: string,
  hash: Hash
): Promise<void> {
  let offset = state.offset;
  input.progress(offset);
  while (offset < state.size) {
    input.signal.throwIfAborted();
    const length = Math.min(TRANSFER_BLOCK_BYTES, state.size - offset);
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(60_000)]);
    const result = await input.client.read(
      { path: input.source, version: state.version, offset, length },
      { signal, timeoutMs: 60_000 }
    );
    if (!result.success) throw new Error(`Download failed: ${JSON.stringify(result.error)}`);
    const blob = result.data;
    const cancel = (): void => blob.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      const bytes = await blob.bytes();
      if (
        bytes.length !== length ||
        blob.meta.size !== length ||
        blob.meta.offset !== offset ||
        blob.meta.version !== state.version ||
        sha(bytes) !== blob.meta.sha256
      )
        throw new Error('Download block checksum or range mismatch');
      await writeAll(handle, bytes, offset);
      await handle.sync();
      hash.update(bytes);
      state.offset = offset + length;
      state.prefixSha256 = hash.copy().digest('hex');
      await writeJson(statePath, state);
      offset += length;
      input.progress(offset);
    } finally {
      signal.removeEventListener('abort', cancel);
      blob.cancel();
    }
  }
  const final = await input.client.inspect(
    { path: input.source },
    { signal: input.signal, timeoutMs: 60_000 }
  );
  if (!final.success || final.data.version !== state.version)
    throw new Error('Source changed during download');
}

async function finishFile(
  input: DownloadFileInput,
  state: Checkpoint,
  partial: string,
  destination: string
): Promise<void> {
  await safeDirectory(
    input.root,
    path.posix.dirname(state.target) === '.' ? '' : path.posix.dirname(state.target)
  );
  const existing = await optionalStat(destination);
  if (state.original !== (existing ? stamp(existing) : null))
    throw new Error(`Destination changed during download: ${destination}`);
  await chmod(partial, input.info.mode & 0o777);
  await utimes(partial, new Date(input.info.mtimeMs), new Date(input.info.mtimeMs));
  // 新文件用排他链接提交；替换在完整校验后执行原子 rename，失败保留旧文件。
  if (state.original) await rename(partial, destination);
  else {
    await link(partial, destination);
    await unlink(partial);
  }
}
