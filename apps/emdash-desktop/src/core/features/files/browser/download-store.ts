import type { ResourceUri } from '@emdash/core/primitives/path/api';
import { LiveJobCancelledError, LiveJobFailedError } from '@emdash/wire/live';
import { makeAutoObservable, runInAction } from 'mobx';
import { getFilesClient } from '../api/browser/client';
import type { DownloadConflict, DownloadProgress } from '../api/downloads';
import { runDownload } from './download-runner';

export class DownloadStore {
  conflict: DownloadConflict = 'keep-both';
  session: { id: string; destination: string } | null = null;
  status: 'ready' | 'running' | 'paused' | 'failed' | 'complete' = 'ready';
  progress: DownloadProgress | undefined;
  error = '';
  private active: AbortController | null = null;

  constructor(readonly sources: ResourceUri[]) {
    makeAutoObservable<this, 'active'>(this, { sources: false, active: false }, { autoBind: true });
  }

  get busy(): boolean {
    return this.status === 'running';
  }
  setConflict(value: DownloadConflict): void {
    this.conflict = value;
  }
  pause(): void {
    this.active?.abort();
  }

  async start(): Promise<void> {
    if (this.busy) return;
    const abort = new AbortController();
    this.active = abort;
    this.status = 'running';
    this.error = '';
    try {
      const client = await getFilesClient();
      const session =
        this.session ??
        (await client.downloads.prepare(
          { sources: this.sources, conflict: this.conflict },
          { timeoutMs: 0 }
        ));
      if (!session) {
        runInAction(() => {
          this.status = 'ready';
        });
        return;
      }
      runInAction(() => {
        this.session = session;
      });
      const progress = await runDownload(client, session.id, abort.signal, (value) =>
        runInAction(() => {
          this.progress = value;
        })
      );
      runInAction(() => {
        this.progress = progress;
        this.status = 'complete';
      });
    } catch (error) {
      runInAction(() => {
        if (
          error instanceof LiveJobCancelledError ||
          (error instanceof DOMException && error.name === 'AbortError')
        )
          this.status = 'paused';
        else {
          this.error = downloadError(error);
          this.status = 'failed';
        }
      });
    } finally {
      this.active = null;
    }
  }

  async discard(): Promise<boolean> {
    if (!this.session || this.busy) return false;
    this.status = 'running';
    try {
      await (await getFilesClient()).downloads.discard({ id: this.session.id });
      runInAction(() => {
        this.status = 'ready';
        this.session = null;
      });
      return true;
    } catch (error) {
      runInAction(() => {
        this.error = downloadError(error);
        this.status = 'failed';
      });
      return false;
    }
  }
}

function downloadError(error: unknown): string {
  if (
    error instanceof LiveJobFailedError &&
    error.error &&
    typeof error.error === 'object' &&
    'message' in error.error &&
    typeof error.error.message === 'string'
  )
    return error.error.message;
  return error instanceof Error ? error.message : String(error);
}
