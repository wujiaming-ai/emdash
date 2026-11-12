import { expect, it } from 'vitest';
import { transcriptTurnSchema } from '../models/turns/turn';
import type { NormalizedEvent } from './normalized-event';
import { AcpTranscriptParser } from './parser';

const activity = (
  turnId: string,
  title: string,
  status: 'running' | 'completed' = 'running'
): Extract<NormalizedEvent, { kind: 'notification' }> => ({
  kind: 'notification',
  title,
  text: '',
  activity: { id: 'retry', category: 'retry', status, severity: 'info', turnId },
});
const user: NormalizedEvent = { kind: 'message', role: 'user', text: 'Work', messageId: null };

it('updates native progress in place without inflating history or creating foreground work', () => {
  const p = new AcpTranscriptParser({ conversationId: 'events' });
  p.pushEvent(user, 0);
  const id = p.activeTurn!.id;
  p.pushEvent(activity(id, 'Retry 1'), 1);
  p.pushEvent(activity(id, 'Retry 2'), 2);
  expect(p.activeTurn!.items).toHaveLength(2);
  expect(p.activeTurn!.items[1]).toMatchObject({ title: 'Retry 2', seq: 1 });
  expect(transcriptTurnSchema.parse(p.activeTurn)).toEqual(p.activeTurn);
});

it('routes late progress to its original turn instead of the next running turn', () => {
  const p = new AcpTranscriptParser({ conversationId: 'events' });
  p.pushEvent(user, 0);
  const id = p.activeTurn!.id;
  p.pushEvent(activity(id, 'Retry 1'), 1);
  p.settleTurn({ kind: 'done' }, 2);
  p.pushEvent(user, 3);
  p.pushEvent(activity(id, 'Recovered', 'completed'), 4);
  expect(p.activeTurn!.items).toHaveLength(1);
  expect(p.history[0].items[1]).toMatchObject({ title: 'Recovered' });
  expect(p.history[0].outcome).toEqual({ kind: 'done' });
});

it('ignores unowned and regressive updates instead of reopening a completed event', () => {
  const p = new AcpTranscriptParser({ conversationId: 'events' });
  p.pushEvent(activity('unknown', 'Stale'), 0);
  expect(p.history).toEqual([]);
  p.pushEvent(user, 1);
  const id = p.activeTurn!.id;
  p.pushEvent(activity(id, 'Recovered', 'completed'), 2);
  p.pushEvent(activity(id, 'Retry 1'), 3);
  expect(p.activeTurn!.items[1]).toMatchObject({ title: 'Recovered' });
});

it('retains reference identity for duplicate progress and does not guess Hook or background completion', () => {
  const p = new AcpTranscriptParser({ conversationId: 'events' });
  p.pushEvent(user, 0);
  const id = p.activeTurn!.id;
  const hook = {
    ...activity(id, 'Hook'),
    activity: { id: 'hook:h', category: 'hook', status: 'running', severity: 'info', turnId: id },
  } as Extract<NormalizedEvent, { kind: 'notification' }>;
  p.pushEvent(hook, 1);
  const before = p.activeTurn;
  p.pushEvent(hook, 2);
  expect(p.activeTurn).toBe(before);
  p.pushEvent(
    {
      ...hook,
      activity: {
        id: 'task:b',
        category: 'task',
        status: 'running',
        severity: 'info',
        background: true,
        turnId: id,
      },
    },
    3
  );
  p.settleTurn({ kind: 'done' }, 4);
  expect(p.history[0].items.slice(1)).toMatchObject([
    { activity: { category: 'hook', status: 'running' } },
    { activity: { category: 'task', status: 'running', background: true } },
  ]);
  p.pushEvent(
    {
      ...hook,
      activity: {
        id: 'task:b',
        category: 'task',
        status: 'completed',
        severity: 'info',
        background: true,
        turnId: id,
      },
    },
    5
  );
  expect(p.history[0].items[2]).toMatchObject({ activity: { status: 'completed' } });
});
