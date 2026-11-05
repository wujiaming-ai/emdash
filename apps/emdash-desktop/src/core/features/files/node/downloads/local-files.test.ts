import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { safeDirectory, safeName } from './local-files';
import { lockDownload } from './lock';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.each([
  '../outside',
  '..',
  '.',
  'a/b',
  'a\\b',
  'a:b',
  'CON',
  'nul.txt',
  'trailing.',
  'bad\0name',
])('rejects unsafe name %s', (name) => {
  expect(() => safeName(name)).toThrow();
});
it('accepts Unicode and spaces without rewriting names', () => {
  expect(safeName('中文 文件.tar.gz')).toBe('中文 文件.tar.gz');
});
it('rejects a symlink ancestor in the local destination', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'download-path-'));
  roots.push(root);
  await mkdir(path.join(root, 'outside'));
  await symlink(path.join(root, 'outside'), path.join(root, 'link'));
  await expect(safeDirectory(await realpath(root), 'link/child')).rejects.toThrow(
    'regular directory'
  );
});
it('excludes a second writer until the first releases its lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'download-lock-'));
  roots.push(root);
  const release = await lockDownload(root);
  await expect(lockDownload(root)).rejects.toThrow('already running');
  await release();
  await (
    await lockDownload(root)
  )();
});
it('rejects a forged checkpoint symlink', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'download-lock-'));
  roots.push(root);
  await writeFile(path.join(root, 'target'), JSON.stringify({ pid: process.pid }));
  await symlink(path.join(root, 'target'), path.join(root, 'active.lock'));
  await expect(lockDownload(root)).rejects.toThrow();
});

it('recovers a lock left by an exited process', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'download-lock-'));
  roots.push(root);
  await writeFile(path.join(root, 'active.lock'), JSON.stringify({ pid: 2147483647 }));
  const release = await lockDownload(root);
  await release();
});
