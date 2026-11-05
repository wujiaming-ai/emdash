import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import type { BlobSource } from '@emdash/wire/rpc';
import { formatAbsolute, type HostAbsolutePath } from '#primitives/path/api';
import type { FsError } from '#runtimes/files/api/errors';
import {
  transferReadSchema,
  type TransferEntry,
  type TransferRead,
} from '#runtimes/files/api/transfer';
import { toFsError } from '../api/errors';

type Key = { path: HostAbsolutePath };
type VersionKey = Key & { version: string };

function nativePath(input: Key): string {
  const value = formatAbsolute(input.path, { separator: path.sep as '/' | '\\' });
  const compatible =
    path.sep === '/' ? input.path.root.kind === 'posix' : input.path.root.kind !== 'posix';
  if (!compatible || !path.isAbsolute(value) || value.includes('\0'))
    throw new Error('Invalid host path');
  return value;
}

function entry(name: string, stat: BigIntStats): TransferEntry {
  const version = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':');
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size)) throw new Error('File size exceeds supported integer range');
  return {
    name,
    version,
    size,
    mode: Number(stat.mode),
    mtimeMs: Number(stat.mtimeNs) / 1e6,
    type: stat.isSymbolicLink()
      ? 'symlink'
      : stat.isFile()
        ? 'file'
        : stat.isDirectory()
          ? 'directory'
          : 'special',
  };
}

export async function inspectTransfer(input: Key): Promise<Result<TransferEntry, FsError>> {
  try {
    const file = nativePath(input);
    return ok(entry(path.basename(file) || 'root', await lstat(file, { bigint: true })));
  } catch (error) {
    return err(toFsError(error, formatAbsolute(input.path)));
  }
}

function checkVersion(info: TransferEntry, expected: string, file: string): void {
  if (info.version !== expected)
    throw Object.assign(new Error('Source changed; restart the download'), {
      transferError: { type: 'etag-mismatch', path: file, expected, actual: info.version },
    });
}

function transferError(error: unknown, file: string): FsError {
  if (error && typeof error === 'object' && 'transferError' in error)
    return error.transferError as FsError;
  return toFsError(error, file);
}

export async function readTransfer(
  input: TransferRead,
  signal?: AbortSignal
): Promise<
  Result<
    {
      meta: {
        name: string;
        mimeType: 'application/octet-stream';
        size: number;
        offset: number;
        version: string;
        sha256: string;
      };
      source: BlobSource;
    },
    FsError
  >
> {
  const valid = transferReadSchema.safeParse(input);
  if (!valid.success)
    return err({ type: 'invalid-path', path: '', message: 'Invalid transfer range' });
  let file = '';
  try {
    signal?.throwIfAborted();
    file = nativePath(input);
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const info = entry(path.basename(file), await handle.stat({ bigint: true }));
      if (info.type !== 'file') throw new Error('Only regular files can be downloaded');
      checkVersion(info, input.version, file);
      if (input.offset > info.size) throw new Error('Offset exceeds file size');
      const bytes = Buffer.alloc(Math.min(input.length, info.size - input.offset));
      let read = 0;
      while (read < bytes.length) {
        signal?.throwIfAborted();
        const next = await handle.read(bytes, read, bytes.length - read, input.offset + read);
        if (!next.bytesRead) throw new Error('Source ended during download');
        read += next.bytesRead;
      }
      checkVersion(entry(info.name, await handle.stat({ bigint: true })), input.version, file);
      return ok({
        meta: {
          name: info.name,
          mimeType: 'application/octet-stream',
          size: bytes.length,
          offset: input.offset,
          version: info.version,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        source: binaryChunks(bytes),
      });
    } finally {
      await handle.close();
    }
  } catch (error) {
    return err(transferError(error, file));
  }
}

async function* binaryChunks(bytes: Buffer): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
    yield bytes.subarray(offset, offset + 64 * 1024);
}

export async function listTransfer(input: VersionKey): Promise<
  Result<
    {
      meta: { name: string; mimeType: 'application/x-ndjson' };
      source: BlobSource;
    },
    FsError
  >
> {
  try {
    const file = nativePath(input);
    const info = entry(path.basename(file) || 'root', await lstat(file, { bigint: true }));
    if (info.type !== 'directory') throw new Error('Only directories can be listed');
    checkVersion(info, input.version, file);
    return ok({
      meta: { name: info.name, mimeType: 'application/x-ndjson' },
      source: directoryEntries(file, input.version),
    });
  } catch (error) {
    return err(transferError(error, formatAbsolute(input.path)));
  }
}

async function* directoryEntries(file: string, version: string): AsyncIterable<Uint8Array> {
  // 惰性打开，Wire 取消或断开时由迭代器关闭目录句柄；不递归跟随符号链接。
  checkVersion(entry(path.basename(file), await lstat(file, { bigint: true })), version, file);
  const directory = await opendir(file);
  for await (const item of directory) {
    const metadata = await lstat(path.join(file, item.name), { bigint: true });
    yield Buffer.from(JSON.stringify(entry(item.name, metadata)) + '\n');
  }
  checkVersion(entry(path.basename(file), await lstat(file, { bigint: true })), version, file);
}
