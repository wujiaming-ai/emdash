import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { encodeResourceUri, type HostFileRef } from '@emdash/core/primitives/path/api';
import { transferEntrySchema, type TransferEntry } from '@emdash/core/runtimes/files/api';
import type { TransferClient } from './download-file';
import { safeName, writeAll } from './local-files';

export async function* directoryEntries(
  client: TransferClient,
  ref: HostFileRef,
  info: TransferEntry,
  staging: string,
  parentSignal: AbortSignal
): AsyncIterable<TransferEntry> {
  const key = createHash('sha256').update(encodeResourceUri(ref)).digest('hex');
  const file = path.join(staging, `${key}.listing`);
  await spoolDirectory(client, ref, info, file, parentSignal);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = handle.createReadStream({ autoClose: false });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      parentSignal.throwIfAborted();
      yield transferEntrySchema.parse(JSON.parse(line));
    }
  } finally {
    lines.close();
    stream.destroy();
    await handle.close();
    await unlink(file);
  }
}

async function spoolDirectory(
  client: TransferClient,
  ref: HostFileRef,
  info: TransferEntry,
  file: string,
  parentSignal: AbortSignal
): Promise<void> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(60_000)]);
  const result = await client.list(
    { path: ref.path, version: info.version },
    { signal, timeoutMs: 60_000 }
  );
  if (!result.success) throw new Error(`Cannot list directory: ${JSON.stringify(result.error)}`);
  const cancel = (): void => result.data.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const handle = await open(
      file,
      constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600
    );
    try {
      let position = 0;
      const names = new Set<string>();
      for await (const entry of parseEntries(result.data.chunks())) {
        signal.throwIfAborted();
        safeName(entry.name);
        const key = entry.name.normalize('NFC').toLowerCase();
        if (names.has(key)) throw new Error(`Filenames collide on this computer: ${entry.name}`);
        names.add(key);
        if (names.size > 100_000) throw new Error('A directory contains more than 100,000 entries');
        const bytes = Buffer.from(JSON.stringify(entry) + '\n');
        await writeAll(handle, bytes, position);
        position += bytes.length;
      }
    } finally {
      await handle.close();
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    result.data.cancel();
  }
}

async function* parseEntries(source: AsyncIterable<Uint8Array>): AsyncIterable<TransferEntry> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  for await (const bytes of source) {
    pending += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      if (newline > 64 * 1024) throw new Error('Invalid directory entry');
      yield transferEntrySchema.parse(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
    }
    if (pending.length > 64 * 1024) throw new Error('Invalid directory entry');
  }
  if ((pending + decoder.decode()).length) throw new Error('Incomplete directory listing');
}
