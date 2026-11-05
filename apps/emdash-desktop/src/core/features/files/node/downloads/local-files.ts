import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export function safeName(name: string): string {
  // 跨平台拒绝路径分隔符及保留名称，不把远端名字当成本地路径执行。
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[\x00-\x1f\\/:<>"|?*]/u.test(name) ||
    /[. ]$/u.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
  ) {
    throw new Error(`Cannot safely save this filename: ${JSON.stringify(name)}`);
  }
  return name;
}

export async function optionalStat(
  file: string
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function safeDirectory(root: string, relative = ''): Promise<string> {
  if ((await realpath(root)) !== root) throw new Error('Download destination changed');
  let current = root;
  for (const segment of relative.split('/').filter(Boolean)) {
    current = path.join(current, safeName(segment));
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Destination is not a regular directory: ${current}`);
  }
  return current;
}

export async function readJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 32 * 1024 * 1024)
      throw new Error('Invalid download checkpoint');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp);
    throw error;
  }
}

export async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (!result.bytesWritten) throw new Error('Disk write made no progress');
    offset += result.bytesWritten;
  }
}
