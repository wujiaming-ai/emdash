import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { NormalizedEvent } from '@emdash/core/runtimes/acp/api';
import { z } from 'zod';

type Notice = Extract<NormalizedEvent, { kind: 'notification' }>;
type Activity = NonNullable<Notice['activity']>;
type RecordValue = Record<string, unknown>;
const object = z.record(z.string(), z.unknown());
const activity = z.object({
  id: z.string().min(1).max(512),
  category: z.enum(['turn', 'tool', 'task', 'hook', 'retry', 'rate_limit', 'notice']),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  severity: z.enum(['info', 'warning', 'error']),
  turnId: z.string().min(1).max(512).optional(),
  background: z.boolean().optional(),
  startedAt: z.number().finite().optional(),
});

/** 扩展只携带展示摘要，绝不转发整个 SDK 消息、prompt 或 Hook 标准输出。 */
export function activityUpdate(title: string, text: string, data: Activity): SessionUpdate {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: title.slice(0, 256) },
    _meta: {
      'emdash.dev/activity': { ...data, title: title.slice(0, 256), text: text.slice(0, 16000) },
    },
  };
}

export function decodeActivity(
  raw: SessionUpdate
): Notice | Extract<NormalizedEvent, { kind: 'ignored' }> | null {
  const data = raw._meta?.['emdash.dev/activity'];
  const parsed = activity
    .extend({ title: z.string().max(256), text: z.string().max(16000) })
    .safeParse(data);
  if (!parsed.success) return data === undefined ? null : { kind: 'ignored' };
  const { title, text, ...meta } = parsed.data;
  return { kind: 'notification', title, text, activity: meta };
}

function record(value: unknown): RecordValue {
  const parsed = object.safeParse(value);
  return parsed.success ? parsed.data : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function notice(
  id: string,
  category: Activity['category'],
  title: string,
  body: string,
  status: Activity['status'],
  turnId?: string,
  severity: Activity['severity'] = 'info',
  background = false
): SessionUpdate {
  return activityUpdate(title, body, {
    id,
    category,
    status,
    severity,
    ...(turnId ? { turnId } : {}),
    ...(background ? { background } : {}),
  });
}

/** 只有适配器自己确认正在收尾 / 等待后台工作时，才更新本轮运行原因。 */
export function turnActivity(turnId: unknown, title: string): SessionUpdate | null {
  return typeof turnId === 'string' && turnId
    ? notice('turn', 'turn', title, '', 'running', turnId)
    : null;
}

function claudeRetry(m: RecordValue, turnId?: string): SessionUpdate[] {
  const attempt = number(m.attempt);
  const max = number(m.max_retries);
  const delay = number(m.retry_delay_ms);
  const count = attempt !== undefined && max !== undefined ? ` · attempt ${attempt} / ${max}` : '';
  const wait = delay !== undefined ? `Retry delay: ${Math.ceil(delay / 1000)}s.` : '';
  const error = number(m.error_status);
  return [
    notice(
      'retry',
      'retry',
      `Retrying Claude${count}`,
      [error ? `HTTP ${error}` : 'Reconnecting to Claude', wait].filter(Boolean).join(' · '),
      'running',
      turnId,
      'warning'
    ),
  ];
}

function claudeHook(m: RecordValue, turnId?: string): SessionUpdate[] {
  const id = text(m.hook_id);
  if (!id) return [];
  const done = m.subtype === 'hook_response';
  if (done && !['success', 'error', 'cancelled'].includes(text(m.outcome))) return [];
  const status = !done
    ? 'running'
    : m.outcome === 'error'
      ? 'failed'
      : m.outcome === 'cancelled'
        ? 'cancelled'
        : 'completed';
  const exit = number(m.exit_code);
  return [
    notice(
      `hook:${id}`,
      'hook',
      text(m.hook_event) ? `${text(m.hook_event)} hook` : 'Hook',
      [text(m.hook_name), exit !== undefined ? `Exit code: ${exit}` : '']
        .filter(Boolean)
        .join('\n'),
      status,
      turnId,
      status === 'failed' ? 'error' : 'info'
    ),
  ];
}

function claudeTask(m: RecordValue, turnId?: string): SessionUpdate[] {
  const id = text(m.task_id);
  if (!id || m.skip_transcript === true || m.ambient === true) return [];
  if (
    m.subtype === 'task_notification' &&
    !['completed', 'failed', 'stopped'].includes(text(m.status))
  )
    return [];
  const done =
    m.subtype === 'task_notification' ||
    (m.subtype === 'task_updated' &&
      ['completed', 'failed', 'killed'].includes(text(record(m.patch).status)));
  const rawStatus = text(m.status) || text(record(m.patch).status);
  const status = !done
    ? 'running'
    : rawStatus === 'failed'
      ? 'failed'
      : ['killed', 'stopped'].includes(rawStatus)
        ? 'cancelled'
        : 'completed';
  const title = text(m.description) || text(record(m.patch).description) || `Task · ${status}`;
  const usage = record(m.usage);
  const uses = number(usage.tool_uses);
  const details = [
    text(m.summary),
    text(m.last_tool_name),
    uses !== undefined ? `${uses} tool calls` : '',
    text(m.output_file),
  ]
    .filter(Boolean)
    .join('\n');
  return [
    notice(
      `task:${id}`,
      'task',
      title,
      details,
      status,
      turnId,
      status === 'failed' ? 'error' : 'info',
      m.is_backgrounded === true || record(m.patch).is_backgrounded === true
    ),
  ];
}

function claudeLimit(m: RecordValue, turnId?: string): SessionUpdate[] {
  const info = record(m.rate_limit_info);
  const status = text(info.status);
  if (!['allowed_warning', 'rejected', 'allowed'].includes(status)) return [];
  // 没有限流风险时不新增日志，恢复事件会原位关闭已存在的警告。
  const title =
    status === 'allowed'
      ? 'Rate limit cleared'
      : status === 'rejected'
        ? 'Rate limit reached'
        : 'Approaching rate limit';
  const used = number(info.utilization);
  return [
    notice(
      `rate_limit:${text(info.rateLimitType) || 'default'}`,
      'rate_limit',
      title,
      [text(info.rateLimitType), used !== undefined ? `${Math.round(used * 100)}% used` : '']
        .filter(Boolean)
        .join(' · '),
      'completed',
      turnId,
      status === 'allowed' ? 'info' : 'warning'
    ),
  ];
}

/** Claude 仅白名单摘要；不把 user/assistant/result 正文当事件展示。 */
export function claudeActivities(raw: unknown, turnId?: string): SessionUpdate[] {
  const m = record(raw);
  if (m.type === 'rate_limit_event') return claudeLimit(m, turnId);
  if (m.type === 'tool_progress') {
    const id = text(m.tool_use_id);
    const elapsed = number(m.elapsed_time_seconds);
    return id
      ? [
          notice(
            `tool:${id}`,
            'tool',
            `${text(m.tool_name) || 'Tool'}${elapsed !== undefined ? ` · ${elapsed}s` : ''}`,
            '',
            'running',
            turnId
          ),
        ]
      : [];
  }
  if (m.type !== 'system') return [];
  const subtype = text(m.subtype);
  if (subtype === 'api_retry') return claudeRetry(m, turnId);
  if (subtype === 'hook_started' || subtype === 'hook_response') return claudeHook(m, turnId);
  if (['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(subtype))
    return claudeTask(m, turnId);
  if (subtype === 'notification' && text(m.text) && (text(m.key) || text(m.uuid)))
    return [
      notice(
        `notice:${text(m.key) || text(m.uuid)}`,
        'notice',
        'Claude notification',
        text(m.text),
        'completed',
        turnId,
        m.priority === 'high' || m.priority === 'immediate' ? 'warning' : 'info'
      ),
    ];
  return [];
}

function codexHook(p: RecordValue, turnId?: string): SessionUpdate[] {
  const run = record(p.run);
  const id = text(run.id);
  if (!id) return [];
  if (!['running', 'completed', 'failed', 'blocked', 'stopped'].includes(text(run.status)))
    return [];
  const status = ['failed', 'blocked', 'error'].includes(text(run.status))
    ? 'failed'
    : run.status === 'stopped'
      ? 'cancelled'
      : run.status === 'running'
        ? 'running'
        : 'completed';
  return [
    notice(
      `hook:${id}`,
      'hook',
      text(run.eventName) ? `${text(run.eventName)} hook` : 'Hook',
      text(run.statusMessage),
      status,
      turnId,
      status === 'failed' ? 'error' : 'info'
    ),
  ];
}

function codexLimits(p: RecordValue, turnId?: string): SessionUpdate[] {
  const limits = record(p.rateLimits);
  return ['primary', 'secondary'].flatMap((key) => {
    const window = record(limits[key]);
    const used = number(window.usedPercent);
    if (used === undefined) return [];
    return [
      notice(
        `rate_limit:${text(limits.limitId) || 'default'}:${key}`,
        'rate_limit',
        used >= 100 ? 'Rate limit reached' : 'Quota usage',
        `${key} · ${used}% used`,
        'completed',
        turnId,
        used >= 100 ? 'warning' : 'info'
      ),
    ];
  });
}

/** Codex 原生只保证 willRetry，不补造次数、倒计时或后台任务终态。 */
export function codexActivities(raw: unknown, turnId?: string): SessionUpdate[] {
  const event = record(raw);
  const p = record(event.params);
  const method = text(event.method);
  if (method === 'error' && p.willRetry === true)
    return [
      notice(
        'retry',
        'retry',
        'Retrying Codex',
        text(record(p.error).message),
        'running',
        turnId,
        'warning'
      ),
    ];
  if (method === 'hook/started' || method === 'hook/completed')
    return codexHook(
      {
        ...p,
        run: {
          ...record(p.run),
          status: method === 'hook/started' ? 'running' : record(p.run).status,
        },
      },
      turnId
    );
  if (method === 'account/rateLimits/updated') return codexLimits(p, turnId);
  if (method === 'item/mcpToolCall/progress' && text(p.itemId))
    return [
      notice(
        `tool:${text(p.itemId)}`,
        'tool',
        'MCP tool progress',
        text(p.message),
        'running',
        turnId
      ),
    ];
  if (method === 'turn/completed' && record(p.turn).status === 'completed') {
    const update = turnActivity(turnId, 'Finishing turn…');
    return update ? [update] : [];
  }
  return [];
}

/** 每个原生 session 单独保留有界归属索引，后台晚到事件不会串到下一轮。 */
export class ActivityReporter {
  private readonly previous = new Map<string, Notice>();
  private readonly nativeTurns = new Map<string, string>();
  private readonly toolTurns = new Map<string, string>();
  private readonly retries = new Map<string, { id: string; active: boolean }>();
  private retrySequence = 0;

  claude(raw: unknown, turnId?: string): SessionUpdate[] {
    const m = record(raw);
    this.captureClaudeTools(m, turnId);
    const mainContent =
      !m.parent_tool_use_id &&
      (m.type === 'assistant' ||
        (m.type === 'stream_event' &&
          ['content_block_start', 'content_block_delta'].includes(text(record(m.event).type))));
    const updates = this.recover(turnId, mainContent);
    if (m.type === 'user' && Array.isArray(record(m.message).content)) {
      for (const block of record(m.message).content as unknown[]) {
        const b = record(block);
        if (b.type === 'tool_result' && text(b.tool_use_id)) {
          updates.push(...this.finishTool(text(b.tool_use_id), b.is_error === true));
        }
      }
    }
    return [...updates, ...this.own(claudeActivities(raw, turnId))];
  }

  /** 首次心跳可能发生在下一轮，工具归属必须在原生启动消息时记录。 */
  private captureClaudeTools(m: RecordValue, turnId?: string): void {
    const owner = this.toolTurns.get(text(m.parent_tool_use_id)) ?? turnId;
    if (!owner) return;
    const content = record(m.message).content;
    const blocks = Array.isArray(content) ? [...content] : [];
    if (m.type === 'stream_event' && record(m.event).type === 'content_block_start') {
      blocks.push(record(m.event).content_block);
    }
    for (const block of blocks) {
      const tool = record(block);
      if (tool.type === 'tool_use' && text(tool.id))
        this.remember(this.toolTurns, text(tool.id), owner);
    }
    if (m.type === 'system' && m.subtype === 'task_started' && text(m.tool_use_id)) {
      this.remember(this.toolTurns, text(m.tool_use_id), owner);
    }
  }

  codex(raw: unknown, turnId?: string): SessionUpdate[] {
    const event = record(raw);
    const p = record(event.params);
    const nativeId = text(p.turnId) || text(record(p.turn).id);
    if (event.method === 'turn/started' && nativeId && turnId)
      this.remember(this.nativeTurns, nativeId, turnId);
    const owner = nativeId ? this.nativeTurns.get(nativeId) : turnId;
    const progress = [
      'item/agentMessage/delta',
      'item/reasoning/textDelta',
      'item/started',
      'item/completed',
    ].includes(text(event.method));
    const updates = this.recover(owner, progress);
    if (event.method === 'item/completed') {
      const item = record(p.item);
      updates.push(...this.finishTool(text(item.id), item.status === 'failed'));
    }
    return [...updates, ...this.own(codexActivities(raw, owner))];
  }

  private recover(turnId: string | undefined, progress: boolean): SessionUpdate[] {
    const retry = turnId ? this.retries.get(turnId) : undefined;
    if (!retry?.active || !progress) return [];
    retry.active = false;
    return [notice(retry.id, 'retry', 'Retry recovered', '', 'completed', turnId)];
  }

  private finishTool(id: string, failed: boolean): SessionUpdate[] {
    const previous = this.previous.get(`tool:${id}`);
    if (!previous?.activity || previous.activity.status !== 'running') return [];
    const update = activityUpdate(previous.title, previous.text, {
      ...previous.activity,
      status: failed ? 'failed' : 'completed',
      severity: failed ? 'error' : 'info',
    });
    return this.own([update]);
  }

  private own(updates: SessionUpdate[]): SessionUpdate[] {
    return updates.flatMap((update) => {
      const parsed = decodeActivity(update);
      if (parsed?.kind !== 'notification' || !parsed.activity) return [];
      let data = parsed.activity;
      if (data.category === 'retry' && data.turnId) data = this.retryActivity(data);
      const prior = this.previous.get(data.id);
      if (data.category === 'rate_limit' && parsed.title === 'Rate limit cleared' && !prior)
        return [];
      if (data.category === 'rate_limit' && parsed.title === 'Quota usage' && !prior) return [];
      if (
        prior?.activity?.status !== undefined &&
        prior.activity.status !== 'running' &&
        data.status === 'running'
      )
        return [];
      const owned = ['task', 'hook', 'tool'].includes(data.category);
      const toolOwner =
        data.category === 'tool' ? this.toolTurns.get(data.id.slice('tool:'.length)) : undefined;
      const owner = owned ? (prior?.activity?.turnId ?? toolOwner ?? data.turnId) : data.turnId;
      // 初始化或未知 native turn 的摘要没有归属，不挂到当前会话的任意一轮。
      if (!owner) return [];
      const meta = {
        ...prior?.activity,
        ...data,
        turnId: owner,
        ...(owned && prior?.activity?.background ? { background: true } : {}),
      };
      const title =
        data.category === 'task' && parsed.title.startsWith('Task ·') && prior
          ? prior.title
          : parsed.title;
      const value: Notice = {
        kind: 'notification',
        title,
        text: parsed.text || prior?.text || '',
        activity: meta,
      };
      this.remember(this.previous, data.id, value);
      return [activityUpdate(value.title, value.text, meta)];
    });
  }

  private retryActivity(data: Activity): Activity {
    const owner = data.turnId!;
    let retry = this.retries.get(owner);
    if (!retry?.active) {
      retry = { id: `retry:${++this.retrySequence}`, active: true };
      this.remember(this.retries, owner, retry);
    }
    return { ...data, id: retry.id };
  }

  private remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.set(key, value);
    if (map.size > 2048) map.delete(map.keys().next().value!);
  }
}
