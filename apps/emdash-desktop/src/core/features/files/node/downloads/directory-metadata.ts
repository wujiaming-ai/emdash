import { createHash } from 'node:crypto';
import { chmod, utimes } from 'node:fs/promises';
import path from 'node:path';
import type { TransferEntry } from '@emdash/core/runtimes/files/api';
import { z } from 'zod';
import { optionalStat, readJson, safeDirectory, safeName, writeJson } from './local-files';

export async function prepareDirectory(
  root: string,
  relative: string,
  staging: string
): Promise<{ path: string; created: boolean }> {
  const target = path.join(root, ...relative.split('/').map(safeName));
  const key = createHash('sha256').update(relative).digest('hex');
  const checkpoint = path.join(staging, `${key}.directory.json`);
  const record = (await optionalStat(checkpoint))
    ? z.object({ created: z.boolean() }).parse(await readJson(checkpoint))
    : { created: !(await optionalStat(target)) };
  await writeJson(checkpoint, record);
  return { path: await safeDirectory(root, relative), created: record.created };
}

export async function finishDirectory(
  directory: { path: string; created: boolean },
  info: TransferEntry
): Promise<void> {
  // 合并已有目录时保留用户原有权限；本次创建的目录才应用来源元数据。
  if (!directory.created) return;
  await chmod(directory.path, (info.mode & 0o777) | 0o700);
  await utimes(directory.path, new Date(info.mtimeMs), new Date(info.mtimeMs));
}
