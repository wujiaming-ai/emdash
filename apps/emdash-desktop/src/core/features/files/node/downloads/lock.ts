import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readJson } from './local-files';

export async function lockDownload(staging: string): Promise<() => Promise<void>> {
  const file = path.join(staging, 'active.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
      } finally {
        await handle.close();
      }
      return () => unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const record = z.object({ pid: z.number().int().positive() }).parse(await readJson(file));
      try {
        process.kill(record.pid, 0);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure;
        await unlink(file);
        continue;
      }
      throw new Error('This download is already running in another window or process');
    }
  }
  throw new Error('Could not acquire the download lock');
}
