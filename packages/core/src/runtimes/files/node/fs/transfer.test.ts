import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runtimeRoot } from '../testing/paths';
import { inspectTransfer, listTransfer, readTransfer } from './transfer';

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'wire-transfer-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('reads exact binary ranges beyond the preview limit and verifies SHA-256', async () => {
  const file = path.join(await fixture(), 'large.bin');
  const handle = await open(file, 'w');
  const offset = 3 * 1024 ** 3 + 17;
  const bytes = Buffer.from([0, 255, 128, 1, 0]);
  await handle.write(bytes, 0, bytes.length, offset);
  await handle.close();
  const info = await inspectTransfer({ path: runtimeRoot(file) });
  if (!info.success) throw new Error(JSON.stringify(info.error));
  const result = await readTransfer({
    path: runtimeRoot(file),
    version: info.data.version,
    offset,
    length: bytes.length,
  });
  if (!result.success) throw new Error(JSON.stringify(result.error));
  const chunks: Uint8Array[] = [];
  for await (const chunk of result.data.source as AsyncIterable<Uint8Array>) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect(result.data.meta.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(result.data.meta.offset).toBe(offset);
});

it('rejects stale resume tokens, invalid ranges and symbolic links', async () => {
  const root = await fixture();
  const file = path.join(root, 'data');
  await writeFile(file, 'old');
  const info = await inspectTransfer({ path: runtimeRoot(file) });
  if (!info.success) throw new Error('inspect failed');
  await writeFile(file, 'changed');
  expect(
    await readTransfer({
      path: runtimeRoot(file),
      version: info.data.version,
      offset: 0,
      length: 1,
    })
  ).toMatchObject({ success: false, error: { type: 'etag-mismatch' } });
  await symlink(file, path.join(root, 'link'));
  expect(
    await readTransfer({
      path: runtimeRoot(path.join(root, 'link')),
      version: info.data.version,
      offset: 0,
      length: 1,
    })
  ).toMatchObject({ success: false });
  expect(
    await readTransfer({ path: runtimeRoot(file), version: '', offset: -1, length: 1 })
  ).toMatchObject({ success: false });
});

it('enumerates hidden files, empty directories and symlinks without following them', async () => {
  const root = await fixture();
  await mkdir(path.join(root, 'empty'));
  await writeFile(path.join(root, '.hidden'), '');
  await symlink(root, path.join(root, 'loop'));
  const info = await inspectTransfer({ path: runtimeRoot(root) });
  if (!info.success) throw new Error('inspect failed');
  const result = await listTransfer({ path: runtimeRoot(root), version: info.data.version });
  if (!result.success) throw new Error('list failed');
  const chunks: Uint8Array[] = [];
  for await (const chunk of result.data.source as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const entries = Buffer.concat(chunks)
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: '.hidden', type: 'file', size: 0 }),
      expect.objectContaining({ name: 'empty', type: 'directory' }),
      expect.objectContaining({ name: 'loop', type: 'symlink' }),
    ])
  );
});
