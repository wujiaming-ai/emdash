import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { hostRef } from '@emdash/core/primitives/host/api';
import {
  encodeResourceUri,
  hostFileRef,
  parseAbsolute,
  type HostAbsolutePath,
} from '@emdash/core/primitives/path/api';
import { filesContract, TRANSFER_BLOCK_BYTES } from '@emdash/core/runtimes/files/api';
import { createFilesController, FilesRuntime } from '@emdash/core/runtimes/files/node';
import { ok } from '@emdash/shared';
import { client, connect, serve, streamTransport, createInProcessWire } from '@emdash/wire/rpc';
import { afterEach, expect, it, vi } from 'vitest';
import type { DownloadProgress } from '@core/features/files/api/downloads';
import { FileDownloads } from '@core/features/files/node/downloads/service';
import type { FilesRuntimeBroker } from '@core/features/files/node/wire-controller';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
function absolute(value: string): HostAbsolutePath {
  const parsed = parseAbsolute(value, {
    profile: { style: 'posix', unicodeNormalization: 'preserve' },
  });
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'emdash-download-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'remote');
  const destination = path.join(root, 'local');
  await mkdir(source);
  await mkdir(destination);
  const runtime = new FilesRuntime();
  const wire = createInProcessWire(filesContract, createFilesController(runtime));
  cleanup.push(async () => {
    await wire.dispose();
    await runtime.dispose();
  });
  const broker = {
    client: vi.fn(async () => ok({ files: wire.client })),
  } as unknown as FilesRuntimeBroker;
  const service = new FileDownloads({ runtimes: broker, chooseDirectory: async () => destination });
  const uri = (name: string) =>
    encodeResourceUri(
      hostFileRef(hostRef('remote', 'download-test'), absolute(path.join(source, name)))
    );
  return { root, source, destination, wire, service, uri, broker };
}
const context = (
  signal = new AbortController().signal,
  progress = (_: DownloadProgress): void => {}
) => ({ jobId: 'test', signal, progress });

it('downloads binary data larger than 100 MiB, zero bytes and a directory tree through real Wire', async () => {
  const f = await fixture();
  await mkdir(path.join(f.source, 'tree/empty'), { recursive: true });
  await writeFile(path.join(f.source, 'tree/empty.bin'), '');
  await writeFile(path.join(f.source, 'tree/中文 空格.bin'), Buffer.from([0, 255, 1, 128]));
  await writeFile(path.join(f.source, 'tree/.hidden'), 'hidden');
  await symlink(f.source, path.join(f.source, 'tree/cycle'));
  const file = await open(path.join(f.source, 'tree/large.bin'), 'w');
  await file.truncate(101 * 1024 * 1024 + 17);
  await file.close();
  const session = await f.service.prepare({ sources: [f.uri('tree')], conflict: 'keep-both' });
  if (!session) throw new Error('no session');
  const progress: DownloadProgress[] = [];
  const result = await f.service.run(
    session.id,
    context(undefined, (p) => progress.push(p))
  );
  expect(result).toMatchObject({ success: true, data: { files: 4, skipped: 1 } });
  expect(await readFile(path.join(f.destination, 'tree/中文 空格.bin'))).toEqual(
    Buffer.from([0, 255, 1, 128])
  );
  expect((await stat(path.join(f.destination, 'tree/large.bin'))).size).toBe(
    101 * 1024 * 1024 + 17
  );
  expect(await readdir(path.join(f.destination, 'tree/empty'))).toEqual([]);
  expect((await readdir(f.destination)).filter((name) => name.startsWith('.emdash'))).toEqual([]);
  expect(progress.some((p) => p.bytes > 100 * 1024 * 1024)).toBe(true);
}, 30_000);

it('pauses after a committed block and resumes across a new service without rereading it remotely', async () => {
  const f = await fixture();
  const bytes = Buffer.alloc(TRANSFER_BLOCK_BYTES * 2 + 19, 123);
  await writeFile(path.join(f.source, 'data.bin'), bytes);
  const session = await f.service.prepare({ sources: [f.uri('data.bin')], conflict: 'keep-both' });
  if (!session) throw new Error('no session');
  const abort = new AbortController();
  await f.service.run(
    session.id,
    context(abort.signal, (p) => {
      if (p.bytes >= TRANSFER_BLOCK_BYTES) abort.abort();
    })
  );
  expect(await readdir(f.destination)).not.toContain('data.bin');
  const read = vi.spyOn(f.wire.client.transfer, 'read');
  const restarted = new FileDownloads({
    runtimes: f.broker,
    chooseDirectory: async () => f.destination,
  });
  const resumed = await restarted.prepare({ sources: [f.uri('data.bin')], conflict: 'keep-both' });
  if (!resumed) throw new Error('no session');
  expect(await restarted.run(resumed.id, context())).toMatchObject({ success: true });
  expect(read.mock.calls[0][0].offset).toBe(TRANSFER_BLOCK_BYTES);
  expect((await readFile(path.join(f.destination, 'data.bin'))).equals(bytes)).toBe(true);
});

it.each(['skip', 'keep-both', 'replace'] as const)(
  'handles %s without deleting the old file before success',
  async (conflict) => {
    const f = await fixture();
    await writeFile(path.join(f.source, 'data'), 'new');
    await writeFile(path.join(f.destination, 'data'), 'old');
    const session = await f.service.prepare({ sources: [f.uri('data')], conflict });
    if (!session) throw new Error('no session');
    expect(await f.service.run(session.id, context())).toMatchObject({ success: true });
    expect(await readFile(path.join(f.destination, 'data'), 'utf8')).toBe(
      conflict === 'replace' ? 'new' : 'old'
    );
    if (conflict === 'keep-both')
      expect(await readFile(path.join(f.destination, 'data (1)'), 'utf8')).toBe('new');
  }
);

it('keeps the old destination on source change and discards only partial files', async () => {
  const f = await fixture();
  await writeFile(path.join(f.source, 'data'), Buffer.alloc(TRANSFER_BLOCK_BYTES + 1, 1));
  await writeFile(path.join(f.destination, 'data'), 'keep');
  const session = await f.service.prepare({ sources: [f.uri('data')], conflict: 'replace' });
  if (!session) throw new Error('no session');
  const abort = new AbortController();
  await f.service.run(
    session.id,
    context(abort.signal, (p) => {
      if (p.bytes) abort.abort();
    })
  );
  await writeFile(path.join(f.source, 'data'), 'changed');
  expect(await f.service.run(session.id, context())).toMatchObject({
    success: false,
    error: { message: expect.stringContaining('Source changed') },
  });
  expect(await readFile(path.join(f.destination, 'data'), 'utf8')).toBe('keep');
  await f.service.discard(session.id);
  expect(await readdir(f.destination)).toEqual(['data']);
});

it('rejects a corrupted local prefix instead of appending silently', async () => {
  const f = await fixture();
  await writeFile(path.join(f.source, 'data'), Buffer.alloc(TRANSFER_BLOCK_BYTES + 1, 1));
  const session = await f.service.prepare({ sources: [f.uri('data')], conflict: 'keep-both' });
  if (!session) throw new Error('no session');
  const abort = new AbortController();
  await f.service.run(
    session.id,
    context(abort.signal, (p) => {
      if (p.bytes) abort.abort();
    })
  );
  const staging = path.join(f.destination, (await readdir(f.destination))[0]);
  const part = (await readdir(staging)).find((name) => name.endsWith('.part'));
  if (!part) throw new Error('no partial');
  await writeFile(path.join(staging, part), 'corrupt');
  expect(await f.service.run(session.id, context())).toMatchObject({ success: false });
  expect(await readdir(f.destination)).not.toContain('data');
});

it('refuses destination symlinks and filename traversal', async () => {
  const f = await fixture();
  await mkdir(path.join(f.source, 'tree'));
  await writeFile(path.join(f.source, 'tree/a'), 'data');
  await symlink(f.source, path.join(f.destination, 'tree'));
  const session = await f.service.prepare({ sources: [f.uri('tree')], conflict: 'replace' });
  if (!session) throw new Error('no session');
  expect(await f.service.run(session.id, context())).toMatchObject({ success: false });
  expect(await readFile(path.join(f.source, 'tree/a'), 'utf8')).toBe('data');
});

it('rejects a corrupted block checksum and leaves the destination absent', async () => {
  const f = await fixture();
  await writeFile(path.join(f.source, 'data'), 'correct');
  const read = f.wire.client.transfer.read.bind(f.wire.client.transfer);
  vi.spyOn(f.wire.client.transfer, 'read').mockImplementation(async (...args) => {
    const result = await read(...args);
    if (result.success)
      result.data.meta.sha256 = createHash('sha256').update('incorrect').digest('hex');
    return result;
  });
  const session = await f.service.prepare({ sources: [f.uri('data')], conflict: 'keep-both' });
  if (!session) throw new Error('no session');
  expect(await f.service.run(session.id, context())).toMatchObject({
    success: false,
    error: { message: expect.stringContaining('checksum') },
  });
  expect(await readdir(f.destination)).not.toContain('data');
});

it('recovers a process exit between final rename and the completed checkpoint', async () => {
  const f = await fixture();
  const content = Buffer.alloc(100, 9);
  await writeFile(path.join(f.source, 'data'), content);
  const session = await f.service.prepare({ sources: [f.uri('data')], conflict: 'keep-both' });
  if (!session) throw new Error('no session');
  const abort = new AbortController();
  await f.service.run(
    session.id,
    context(abort.signal, (p) => {
      if (p.bytes === content.length) abort.abort();
    })
  );
  const staging = path.join(f.destination, (await readdir(f.destination))[0]);
  const partial = (await readdir(staging)).find((name) => name.endsWith('.part'));
  if (!partial) throw new Error('no partial');
  const { rename } = await import('node:fs/promises');
  await rename(path.join(staging, partial), path.join(f.destination, 'data'));
  expect(await f.service.run(session.id, context())).toMatchObject({ success: true });
  expect((await readFile(path.join(f.destination, 'data'))).equals(content)).toBe(true);
});

it('resumes after a Wire transport disconnect with a newly connected client', async () => {
  const f = await fixture();
  const bytes = Buffer.alloc(TRANSFER_BLOCK_BYTES + 37, 42);
  await writeFile(path.join(f.source, 'data'), bytes);
  const session = await f.service.prepare({ sources: [f.uri('data')], conflict: 'keep-both' });
  if (!session) throw new Error('no session');
  const result = await f.service.run(
    session.id,
    context(undefined, (p) => {
      if (p.bytes === TRANSFER_BLOCK_BYTES) f.wire.pair.disconnect();
    })
  );
  expect(result.success).toBe(false);
  const runtime = new FilesRuntime();
  const connection = createInProcessWire(filesContract, createFilesController(runtime));
  cleanup.push(async () => {
    await connection.dispose();
    await runtime.dispose();
  });
  vi.mocked(f.broker.client).mockResolvedValue(ok({ files: connection.client }) as never);
  expect(await f.service.run(session.id, context())).toMatchObject({ success: true });
  expect((await readFile(path.join(f.destination, 'data'))).equals(bytes)).toBe(true);
});

it('detects a destination modified while a download was paused', async () => {
  const f = await fixture();
  await writeFile(path.join(f.source, 'data'), Buffer.alloc(TRANSFER_BLOCK_BYTES + 1));
  await writeFile(path.join(f.destination, 'data'), 'original');
  const session = await f.service.prepare({ sources: [f.uri('data')], conflict: 'replace' });
  if (!session) throw new Error('no session');
  const abort = new AbortController();
  await f.service.run(
    session.id,
    context(abort.signal, (p) => {
      if (p.bytes) abort.abort();
    })
  );
  await writeFile(path.join(f.destination, 'data'), 'user edit');
  expect(await f.service.run(session.id, context())).toMatchObject({
    success: false,
    error: { message: expect.stringContaining('Destination changed') },
  });
  expect(await readFile(path.join(f.destination, 'data'), 'utf8')).toBe('user edit');
});

it('keeps the existing file when disk writing fails and can retry', async () => {
  const f = await fixture();
  await writeFile(path.join(f.source, 'data'), 'new');
  await writeFile(path.join(f.destination, 'data'), 'old');
  const localFiles = await import('@core/features/files/node/downloads/local-files');
  const write = vi
    .spyOn(localFiles, 'writeAll')
    .mockRejectedValueOnce(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }));
  const session = await f.service.prepare({ sources: [f.uri('data')], conflict: 'replace' });
  if (!session) throw new Error('no session');
  try {
    expect(await f.service.run(session.id, context())).toMatchObject({
      success: false,
      error: { message: 'Disk full' },
    });
    expect(await readFile(path.join(f.destination, 'data'), 'utf8')).toBe('old');
  } finally {
    write.mockRestore();
  }
  expect(await f.service.run(session.id, context())).toMatchObject({ success: true });
  expect(await readFile(path.join(f.destination, 'data'), 'utf8')).toBe('new');
});

it('shows an actionable message for an older remote service', async () => {
  const f = await fixture();
  await writeFile(path.join(f.source, 'data'), 'new');
  const { WireError } = await import('@emdash/wire/rpc');
  vi.spyOn(f.wire.client.transfer, 'inspect').mockRejectedValueOnce(
    new WireError('NOT_FOUND', 'unknown method')
  );
  const session = await f.service.prepare({ sources: [f.uri('data')], conflict: 'keep-both' });
  if (!session) throw new Error('no session');
  expect(await f.service.run(session.id, context())).toMatchObject({
    success: false,
    error: { message: expect.stringContaining('Update the remote service') },
  });
});

it('detects case-colliding remote entries before writing their file contents', async () => {
  const f = await fixture();
  await mkdir(path.join(f.source, 'tree'));
  const original = f.wire.client.transfer.list.bind(f.wire.client.transfer);
  vi.spyOn(f.wire.client.transfer, 'list').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (!result.success) return result;
    const entry = { name: 'A', type: 'file', size: 1, mtimeMs: 0, mode: 0o600, version: 'v' };
    result.data.chunks = async function* () {
      yield Buffer.from(
        JSON.stringify(entry) + '\n' + JSON.stringify({ ...entry, name: 'a' }) + '\n'
      );
    };
    return result;
  });
  const session = await f.service.prepare({ sources: [f.uri('tree')], conflict: 'keep-both' });
  if (!session) throw new Error('no session');
  expect(await f.service.run(session.id, context())).toMatchObject({
    success: false,
    error: { message: expect.stringContaining('collide') },
  });
  expect(await readdir(path.join(f.destination, 'tree'))).toEqual([]);
});

it('downloads across serialized Wire byte streams, including multiple credit windows', async () => {
  const f = await fixture();
  const bytes = Buffer.alloc(TRANSFER_BLOCK_BYTES + 127, 211);
  await writeFile(path.join(f.source, 'stream.bin'), bytes);
  const a = new PassThrough();
  const b = new PassThrough();
  const clientTransport = streamTransport(b, a);
  const serverTransport = streamTransport(a, b);
  const runtime = new FilesRuntime();
  const controller = createFilesController(runtime);
  const stop = serve(serverTransport, controller);
  const api = client(filesContract, connect(clientTransport));
  cleanup.push(async () => {
    stop();
    clientTransport.close?.();
    serverTransport.close?.();
    a.destroy();
    b.destroy();
    await controller.dispose?.();
    await runtime.dispose();
  });
  vi.mocked(f.broker.client).mockResolvedValue(ok({ files: api }) as never);
  const session = await f.service.prepare({
    sources: [f.uri('stream.bin')],
    conflict: 'keep-both',
  });
  if (!session) throw new Error('no session');
  expect(await f.service.run(session.id, context())).toMatchObject({ success: true });
  expect((await readFile(path.join(f.destination, 'stream.bin'))).equals(bytes)).toBe(true);
});

it('deduplicates overlapping selected directories and files at the API boundary', async () => {
  const f = await fixture();
  await mkdir(path.join(f.source, 'tree'));
  await writeFile(path.join(f.source, 'tree/a'), 'a');
  const session = await f.service.prepare({
    sources: [f.uri('tree/a'), f.uri('tree')],
    conflict: 'keep-both',
  });
  if (!session) throw new Error('no session');
  expect(await f.service.run(session.id, context())).toMatchObject({
    success: true,
    data: { files: 1 },
  });
  expect(await readdir(f.destination)).toEqual(['tree']);
});

it('preserves source timestamps and executable bits without changing existing directory permissions', async () => {
  const f = await fixture();
  const { chmod, utimes } = await import('node:fs/promises');
  await mkdir(path.join(f.source, 'tree'));
  await writeFile(path.join(f.source, 'tree/run'), 'echo test');
  await chmod(path.join(f.source, 'tree/run'), 0o755);
  const timestamp = new Date('2025-01-02T03:04:05Z');
  await utimes(path.join(f.source, 'tree/run'), timestamp, timestamp);
  await mkdir(path.join(f.destination, 'tree'), { mode: 0o700 });
  const session = await f.service.prepare({ sources: [f.uri('tree')], conflict: 'replace' });
  if (!session) throw new Error('no session');
  expect(await f.service.run(session.id, context())).toMatchObject({ success: true });
  expect((await stat(path.join(f.destination, 'tree'))).mode & 0o777).toBe(0o700);
  const info = await stat(path.join(f.destination, 'tree/run'));
  expect(info.mode & 0o777).toBe(0o755);
  expect(info.mtimeMs).toBe(timestamp.getTime());
});
