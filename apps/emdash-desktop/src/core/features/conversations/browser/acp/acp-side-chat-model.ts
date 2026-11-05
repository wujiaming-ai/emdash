import { action, makeObservable, observable, runInAction } from 'mobx';
import { log } from '@core/primitives/logging/browser/logger';
import type { AcpLiveSession } from './acp-live-session';

export type SideClient = Pick<AcpLiveSession, 'sideQuestion'>;
export type SideMessage = { id: string; role: 'user' | 'assistant'; text: string; quote?: string };

/** 状态只属于当前旁支，不持久化，也不操作主会话的发送与停止。 */
export class AcpSideChatModel {
  messages: SideMessage[] = [];
  draft = '';
  busy = false;
  error: string | null = null;
  private disposed = false;
  private stopped = false;

  constructor(
    private readonly client: SideClient,
    private readonly sideId: string
  ) {
    makeObservable(this, {
      messages: observable.shallow,
      draft: observable,
      busy: observable,
      error: observable,
      setDraft: action.bound,
      ask: action.bound,
      stop: action.bound,
    });
  }

  setDraft(text: string): void {
    this.draft = text;
  }

  async ask(quote: string): Promise<void> {
    if (this.busy || this.disposed || !this.draft.trim()) return;
    const question = this.draft.trim();
    this.busy = true;
    this.stopped = false;
    this.error = null;
    this.draft = '';
    this.messages = [
      ...this.messages,
      { id: crypto.randomUUID(), role: 'user', text: question, quote },
    ];
    try {
      const result = await this.client.sideQuestion({
        sideId: this.sideId,
        action: 'ask',
        question,
        quote: quote || undefined,
      });
      if (!result.success) throw result.error;
      runInAction(() => {
        if (!this.disposed && !this.stopped)
          this.messages = [
            ...this.messages,
            { id: crypto.randomUUID(), role: 'assistant', text: result.data.text },
          ];
      });
    } catch (failure) {
      runInAction(() => {
        if (!this.disposed && !this.stopped) this.error = sideError(failure);
      });
    } finally {
      runInAction(() => {
        this.busy = false;
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      const result = await this.client.sideQuestion({ sideId: this.sideId, action: 'cancel' });
      if (!result.success) throw result.error;
    } catch (failure) {
      runInAction(() => {
        if (!this.disposed) this.error = sideError(failure);
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    void this.client
      .sideQuestion({ sideId: this.sideId, action: 'close' })
      .then((result) => {
        if (!result.success) log.warn('Side chat cleanup failed', { error: result.error });
      })
      .catch((error: unknown) => log.warn('Side chat cleanup failed', { error }));
  }
}

function sideError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    if ('cause' in error) return sideError(error.cause);
    if ('message' in error && typeof error.message === 'string') return error.message;
  }
  return 'Side chat is unavailable. Reconnect the conversation and try again.';
}
