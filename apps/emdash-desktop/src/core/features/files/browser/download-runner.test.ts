import { ok, err } from '@emdash/shared';
import { deferred } from '@emdash/shared/testing';
import { LiveJobCancelledError } from '@emdash/wire/live';
import { createInProcessWire } from '@emdash/wire/rpc';
import { expect, it } from 'vitest';
import type { FilesClient } from '../api/browser/client';
import { downloadsContract, type DownloadProgress } from '../api/downloads';
import { runDownload } from './download-runner';

const progress: DownloadProgress = {
  path: 'file',
  bytes: 1,
  size: 2,
  files: 0,
  transferred: 1,
  skipped: 0,
  warnings: [],
};
it('forwards progress and awaits server cancellation through the real desktop Wire job', async () => {
  const gate = deferred<void>();
  const aborted = deferred<void>();
  const wire = createInProcessWire(downloadsContract, {
    prepare: () => null,
    discard: () => {},
    run: {
      run: async (_input, context) => {
        await gate.promise;
        context.progress(progress);
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            'abort',
            () => {
              aborted.resolve();
              resolve();
            },
            { once: true }
          );
        });
        return ok(progress);
      },
    },
  });
  const abort = new AbortController();
  const observed: DownloadProgress[] = [];
  const result = runDownload({ downloads: wire.client } as FilesClient, 'id', abort.signal, (p) => {
    observed.push(p);
    abort.abort();
  });
  try {
    gate.resolve();
    await expect(result).rejects.toBeInstanceOf(LiveJobCancelledError);
    await aborted.promise;
    expect(observed).toEqual([progress]);
  } finally {
    await wire.dispose();
  }
});
it('retains the typed failure message for a retry', async () => {
  const wire = createInProcessWire(downloadsContract, {
    prepare: () => null,
    discard: () => {},
    run: { run: () => err({ message: 'disk full' }) },
  });
  try {
    await expect(
      runDownload(
        { downloads: wire.client } as FilesClient,
        'id',
        new AbortController().signal,
        () => {}
      )
    ).rejects.toMatchObject({ error: { message: 'disk full' } });
  } finally {
    await wire.dispose();
  }
});
