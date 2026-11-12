import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { TranscriptItem, TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';

type Notice = Extract<TranscriptItem, { kind: 'notification' }>;
const cleanups: Array<() => void> = [];
const paint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function event(id: string, status: 'running' | 'completed' | 'failed' = 'completed'): Notice {
  return {
    kind: 'notification',
    id,
    seq: 0,
    title: `Hook ${id}`,
    text: `Details for ${id}`,
    activity: {
      id,
      category: 'hook',
      status,
      severity: status === 'failed' ? 'error' : 'info',
      turnId: 't',
    },
  };
}

function mount(items: TranscriptItem[], width: number, active = false, dark = false) {
  const context = createChatContext();
  const state = createChatState(context, { uri: 'activity' });
  const turn: TranscriptTurn = { id: 't', seq: 0, initiator: 'user', items };
  if (active) state.transcript.activeTurn.set(turn, 'generating');
  else state.transcript.history.seed([turn]);
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;top:0;left:0;width:${width}px;height:500px;`;
  if (dark) host.classList.add('emdark');
  document.body.append(host);
  const view = createChatView({ context, state, parent: host });
  cleanups.push(() => {
    view.dispose();
    state.dispose();
    context.dispose();
    host.remove();
  });
  return { host, state, view };
}

describe('native activity presentation', () => {
  it.each([320, 800])(
    'folds only adjacent completed events and preserves disclosure at %s px',
    async (width) => {
      const { host } = mount([event('a'), event('b'), event('error', 'failed')], width);
      await paint();
      const group = host.querySelector<HTMLElement>('[data-activity-group] [role=button]')!;
      expect(group.textContent).toContain('2 completed events');
      expect(group.getAttribute('aria-expanded')).toBe('false');
      expect(host.textContent).not.toContain('Details for a');
      expect(host.textContent).toContain('Details for error');
      group.click();
      await paint();
      expect(group.getAttribute('aria-expanded')).toBe('true');
      const child = host.querySelector<HTMLElement>('[data-collapse-id=a]')!;
      child.click();
      await paint();
      expect(host.textContent).toContain('Details for a');
      const groupRect = group.parentElement!.getBoundingClientRect();
      const errorRect = host
        .querySelector<HTMLElement>('[data-activity-id=error]')!
        .getBoundingClientRect();
      expect(groupRect.bottom).toBeLessThanOrEqual(errorRect.top + 1);
      host.querySelector<HTMLElement>('[data-activity-group] [role=button]')!.click();
      await paint();
      await vi.waitFor(() => expect(host.textContent).not.toContain('Details for a'));
      host
        .querySelector<HTMLElement>('[data-activity-group] [role=button]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await paint();
      expect(host.textContent).toContain('Details for a');
    }
  );

  it.each([false, true])(
    'shows running and warning details without markup or duplicate Working rows (dark=%s)',
    async (dark) => {
      const working = event('turn', 'running');
      working.activity!.category = 'turn';
      working.title = 'Waiting for background agents…';
      working.text = '';
      const retry = event('retry', 'running');
      retry.activity!.category = 'retry';
      retry.activity!.severity = 'warning';
      retry.title = 'Retrying Claude';
      retry.text = '<script>private()</script> **literal** [link](https://example.com)';
      const { host } = mount([working, retry], 320, true, dark);
      await paint();
      expect(host.textContent).toContain('Waiting for background agents…');
      expect(host.textContent).toContain('<script>private()</script>');
      expect(host.textContent).not.toContain('Working…');
      expect(host.querySelector('script,a,img')).toBeNull();
      expect(host.querySelector('[data-activity-group]')).toBeNull();
      for (const row of host.querySelectorAll<HTMLElement>('[data-activity]')) {
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
        expect(row.getBoundingClientRect().height).toBeGreaterThan(0);
      }
    }
  );

  it('updates in place and removes active styling after a terminal snapshot', async () => {
    const { host, state } = mount([event('a', 'running')], 800, true);
    await paint();
    expect(host.textContent).toContain('Running');
    state.transcript.activeTurn.set(null);
    state.transcript.history.seed([{ id: 't', seq: 0, initiator: 'user', items: [event('a')] }]);
    await paint();
    expect(host.querySelectorAll('[data-activity]')).toHaveLength(1);
    expect(host.textContent).toContain('Completed');
    expect(host.textContent).not.toContain('Running');
    host.querySelector<HTMLElement>('[data-collapse-id=a]')!.click();
    await paint();
    expect(host.textContent).toContain('Details for a');
  });

  it('clips long labels and measures expanded wrapped details at narrow width', async () => {
    const long = event('long');
    long.title = 'Long Hook label '.repeat(20);
    long.text = 'Wrapped progress detail '.repeat(60);
    const { host, view } = mount(
      [long, { kind: 'message', id: 'reply', role: 'assistant', text: 'Next message', seq: 1 }],
      320
    );
    await paint();
    host.querySelector<HTMLElement>('[data-collapse-id=long]')!.click();
    await paint();
    const row = host.querySelector<HTMLElement>('[data-activity]')!;
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    view.scrollToBottom();
    await paint();
    const reply = host.querySelector<HTMLElement>('[data-block-id="reply#0"]')!;
    expect(reply.textContent).toContain('Next message');
    expect(reply.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      row.getBoundingClientRect().bottom - 1
    );
  });
});
