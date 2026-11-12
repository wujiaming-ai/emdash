import { describe, expect, it } from 'vitest';
import { enrichClaudeUpdate } from '../impl/claude/acp-transform';
import { enrichCodexUpdate } from '../impl/codex/acp-enrich';
import {
  ActivityReporter,
  activityUpdate,
  claudeActivities,
  codexActivities,
  decodeActivity,
} from './activity-events';

const claude = (subtype: string, data: Record<string, unknown> = {}): unknown => ({
  type: 'system',
  subtype,
  ...data,
});
const codex = (method: string, params: Record<string, unknown> = {}): unknown => ({
  method,
  params,
});

describe('native activity summaries', () => {
  it('passes validated summaries through both enrichment hooks without assistant text', () => {
    const raw = activityUpdate('Retrying', 'HTTP 429', {
      id: 'r',
      category: 'retry',
      status: 'running',
      severity: 'warning',
      turnId: 't',
    });
    const baseline = {
      kind: 'message',
      role: 'assistant',
      messageId: null,
      text: 'Retrying',
    } as const;
    expect(enrichClaudeUpdate(baseline, raw)).toEqual(decodeActivity(raw));
    expect(enrichCodexUpdate(baseline, raw)).toEqual(decodeActivity(raw));
    const invalid = { ...raw, _meta: { 'emdash.dev/activity': { id: [] } } };
    expect(enrichClaudeUpdate(baseline, invalid)).toEqual({ kind: 'ignored' });
    expect(enrichCodexUpdate(baseline, invalid)).toEqual({ kind: 'ignored' });
    expect(enrichCodexUpdate(baseline, { ...raw, _meta: undefined })).toBe(baseline);
  });

  it('forwards only Hook summaries and rejects unknown payloads', () => {
    const raw = claude('hook_response', {
      hook_id: 'h',
      hook_event: 'Stop',
      hook_name: 'check',
      outcome: 'error',
      exit_code: 1,
      stdout: 'private-output',
      stderr: 'private-error',
      output: 'private-output',
      prompt: 'private-prompt',
    });
    const updates = claudeActivities(raw, 't');
    expect(decodeActivity(updates[0])).toMatchObject({
      title: 'Stop hook',
      text: 'check\nExit code: 1',
      activity: { status: 'failed', severity: 'error' },
    });
    expect(JSON.stringify(updates)).not.toContain('private-');
    expect(claudeActivities(claude('future_event', { prompt: 'private-prompt' }), 't')).toEqual([]);
    expect(
      codexActivities(codex('hook/completed', { run: { id: 'h', status: 'future' } }), 't')
    ).toEqual([]);
    expect(codexActivities(null)).toEqual([]);
  });

  it.each(['completed', 'failed', 'stopped'])(
    'retains Claude task ownership and background level on %s',
    (status) => {
      const reporter = new ActivityReporter();
      reporter.claude(
        claude('task_started', {
          task_id: 'a',
          description: 'Inspect tests',
          is_backgrounded: true,
          prompt: 'private-prompt',
        }),
        'first'
      );
      const [update] = reporter.claude(
        claude('task_notification', {
          task_id: 'a',
          status,
          summary: 'Checked tests',
          usage: { tool_uses: 3 },
        }),
        'second'
      );
      expect(decodeActivity(update)).toMatchObject({
        title: 'Inspect tests',
        text: 'Checked tests\n3 tool calls',
        activity: {
          turnId: 'first',
          background: true,
          status: status === 'stopped' ? 'cancelled' : status,
        },
      });
      expect(
        reporter.claude(
          claude('task_progress', { task_id: 'a', description: 'Stale beat' }),
          'second'
        )
      ).toEqual([]);
      expect(
        reporter.claude(claude('task_started', { task_id: 'ambient', ambient: true }), 'second')
      ).toEqual([]);
    }
  );

  it('closes real tool progress on tool_result, without merging it into its parent', () => {
    const reporter = new ActivityReporter();
    reporter.claude(
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'bash' } },
      },
      'first'
    );
    const [beat] = reporter.claude(
      {
        type: 'tool_progress',
        tool_use_id: 'bash',
        parent_tool_use_id: 'agent',
        tool_name: 'Bash',
        elapsed_time_seconds: 8,
      },
      'second'
    );
    expect(decodeActivity(beat)).toMatchObject({ activity: { id: 'tool:bash', turnId: 'first' } });
    const [done] = reporter.claude(
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash' }] } },
      'second'
    );
    expect(decodeActivity(done)).toMatchObject({
      activity: { turnId: 'first', status: 'completed' },
    });
  });

  it('recovers retry on real progress and opens a separate later retry episode', () => {
    const reporter = new ActivityReporter();
    const retry = claude('api_retry', {
      attempt: 1,
      max_retries: 5,
      retry_delay_ms: 2000,
      error_status: 429,
    });
    const [first] = reporter.claude(retry, 't');
    expect(decodeActivity(first)).toMatchObject({
      title: 'Retrying Claude · attempt 1 / 5',
      text: 'HTTP 429 · Retry delay: 2s.',
    });
    expect(reporter.claude(claude('hook_started', { hook_id: 'h' }), 't')).toHaveLength(1);
    const [recovered] = reporter.claude({ type: 'assistant' }, 't');
    expect(decodeActivity(recovered)).toMatchObject({
      title: 'Retry recovered',
      activity: { status: 'completed' },
    });
    expect(decodeActivity(reporter.claude(retry, 't')[0])?.kind).toBe('notification');
    expect(reporter.claude({ type: 'assistant' }, 't')[0]._meta).not.toEqual(recovered._meta);
  });

  it('does not emit healthy quota logs but updates an existing warning in place', () => {
    const reporter = new ActivityReporter();
    const limit = (status: string) => ({
      type: 'rate_limit_event',
      rate_limit_info: { status, rateLimitType: 'five_hour', utilization: 0.9 },
    });
    expect(reporter.claude(limit('allowed'), 't')).toEqual([]);
    const [warning] = reporter.claude(limit('allowed_warning'), 't');
    const [cleared] = reporter.claude(limit('allowed'), 't');
    expect(decodeActivity(warning)).toMatchObject({ activity: { severity: 'warning' } });
    expect(decodeActivity(cleared)).toMatchObject({
      title: 'Rate limit cleared',
      activity: { severity: 'info' },
    });
    const quota = (usedPercent: number) =>
      codex('account/rateLimits/updated', { rateLimits: { primary: { usedPercent } } });
    expect(reporter.codex(quota(70), 't')).toEqual([]);
    expect(decodeActivity(reporter.codex(quota(100), 't')[0])).toMatchObject({
      title: 'Rate limit reached',
    });
    expect(decodeActivity(reporter.codex(quota(20), 't')[0])).toMatchObject({
      title: 'Quota usage',
      text: 'primary · 20% used',
      activity: { severity: 'info' },
    });
  });

  it('routes Codex native turn ids, real retries and hook failures without invented counters', () => {
    const reporter = new ActivityReporter();
    reporter.codex(codex('turn/started', { turn: { id: 'native' } }), 'first');
    const [retry] = reporter.codex(
      codex('error', {
        turnId: 'native',
        willRetry: true,
        error: { message: 'stream disconnected' },
      }),
      'second'
    );
    expect(decodeActivity(retry)).toMatchObject({
      title: 'Retrying Codex',
      activity: { turnId: 'first' },
    });
    const [recovered] = reporter.codex(
      codex('item/agentMessage/delta', { turnId: 'native' }),
      'second'
    );
    expect(decodeActivity(recovered)).toMatchObject({
      title: 'Retry recovered',
      activity: { turnId: 'first' },
    });
    expect(
      reporter.codex(codex('error', { turnId: 'unknown', willRetry: true }), 'second')
    ).toEqual([]);
    const [hook] = reporter.codex(
      codex('hook/completed', {
        turnId: 'native',
        run: {
          id: 'h',
          eventName: 'Stop',
          status: 'blocked',
          statusMessage: 'Validation blocked',
          entries: [{ stdout: 'private-output' }],
        },
      }),
      'second'
    );
    expect(decodeActivity(hook)).toMatchObject({
      title: 'Stop hook',
      text: 'Validation blocked',
      activity: { turnId: 'first', status: 'failed' },
    });
    expect(JSON.stringify(hook)).not.toContain('private-output');
  });
});
