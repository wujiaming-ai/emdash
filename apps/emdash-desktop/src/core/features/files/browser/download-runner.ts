import { createLiveJobReplicaCache } from '@emdash/wire/live';
import type { FilesClient } from '../api/browser/client';
import { filesWireContract } from '../api/contract';
import type { DownloadProgress } from '../api/downloads';

export async function runDownload(
  client: FilesClient,
  id: string,
  signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void
): Promise<DownloadProgress> {
  const jobs = createLiveJobReplicaCache(filesWireContract.downloads.run, client.downloads.run);
  try {
    signal.throwIfAborted();
    const lease = await jobs.start({ id });
    try {
      const job = await lease.ready();
      const unsubscribe = job.onProgress(onProgress);
      // 任务可能在订阅前已经报告进度，先恢复快照中的最后状态。
      const latest = job.getState()?.progress.at(-1);
      if (latest) onProgress(latest);
      let rejectCancellation: (error: unknown) => void = () => {};
      const cancellationFailed = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
      });
      let cancelling: Promise<void> | undefined;
      const cancel = (): void => {
        cancelling ??= job.cancel().catch(rejectCancellation);
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        return await Promise.race([job.result, cancellationFailed]);
      } finally {
        signal.removeEventListener('abort', cancel);
        unsubscribe();
        await cancelling;
      }
    } finally {
      await lease.release();
    }
  } finally {
    await jobs.dispose();
  }
}
