import { useTheme } from '@components/contexts/ThemeContext';
import { HEADER_ROW_EXTRA_H } from '@components/engine/row-metrics';
import { BlockStackView } from '@components/primitives/BlockStackView';
import { CollapseHeader } from '@components/primitives/CollapseHeader';
import type { MeasureCtx, RenderCtx } from '@core/define';
import { layoutBlockStack } from '@core/layout/block-stack';
import type { Block, InlineRun } from '@core/markdown/document';
import { defineUnit } from '@core/units';
import { For, Show, createMemo, type JSX } from 'solid-js';
import type { ActivityGroupItem, TranscriptItem } from '@/model';
import { activityHeader, activityLabel, activityRoot } from './activity.css';
import { textShimmer } from '@styles/effects.css';
import { vars } from '@styles/theme.css';

type Notification = Extract<TranscriptItem, { kind: 'notification' }>;

/** 原生摘要按纯文本展示，避免事件内容生成 HTML、链接或交互控件。 */
function bodyBlocks(item: Notification): Block[] {
  return item.text
    ? [
        {
          kind: 'prose',
          id: `${item.id}#activity-body`,
          variant: 'body',
          runs: item.text
            .split('\n')
            .flatMap((line, index): InlineRun[] => [
              ...(index ? [{ kind: 'break' as const }] : []),
              { kind: 'text', text: line },
            ]),
        },
      ]
    : [];
}

function headerHeight(ctx: MeasureCtx): number {
  return ctx.theme.fonts.body.lineHeight + HEADER_ROW_EXTRA_H;
}

function alwaysVisible(item: Notification): boolean {
  return item.activity?.status === 'running' || item.activity?.severity !== 'info';
}

function label(item: Notification): string {
  const activity = item.activity!;
  return ['hook', 'task', 'tool'].includes(activity.category)
    ? `${item.title} · ${activity.status === 'running' ? 'Running' : activity.status === 'completed' ? 'Completed' : activity.status === 'failed' ? 'Failed' : 'Cancelled'}`
    : item.title;
}

export function activityHeight(item: Notification, ctx: MeasureCtx): number {
  const expanded = alwaysVisible(item) || ctx.expanded(item.id);
  return (
    headerHeight(ctx) +
    (expanded && item.text
      ? layoutBlockStack(bodyBlocks(item), ctx, { isCollapsed: ctx.isCollapsed }).height
      : 0)
  );
}

function activityColor(item: Notification): string {
  if (item.activity?.severity === 'error') return vars.fgError;
  return item.activity?.severity === 'warning'
    ? `var(--em-foreground-warning, ${vars.fgMuted})`
    : vars.fgMuted;
}

function ActivityHeader(props: {
  item: Notification;
  expanded: boolean;
  height: number;
}): JSX.Element {
  return (
    <Show
      when={props.item.text && !alwaysVisible(props.item)}
      fallback={
        <div class={activityHeader} style={{ height: `${props.height}px` }}>
          <span
            class={activityLabel}
            classList={{ [textShimmer]: props.item.activity?.status === 'running' }}
            title={label(props.item)}
          >
            {label(props.item)}
          </span>
        </div>
      }
    >
      <CollapseHeader keyboard id={props.item.id} expanded={props.expanded} height={props.height}>
        <span class={activityLabel} title={label(props.item)}>
          {label(props.item)}
        </span>
      </CollapseHeader>
    </Show>
  );
}

export function ActivityRender(props: {
  item: Notification;
  ctx: RenderCtx;
  nested?: boolean;
}): JSX.Element {
  const theme = useTheme();
  const expanded = () =>
    alwaysVisible(props.item) || props.ctx.viewState.isCollapsed(props.item.id);
  const h = () => theme().fonts.body.lineHeight + HEADER_ROW_EXTRA_H;
  const body = createMemo(() => {
    const ctx = props.ctx.measureCtx?.();
    return ctx && expanded()
      ? layoutBlockStack(bodyBlocks(props.item), ctx, { isCollapsed: ctx.isCollapsed })
      : null;
  });
  const height = () => {
    if (props.nested) return undefined;
    const ctx = props.ctx.measureCtx?.();
    return `${props.ctx.clipHeight?.() ?? (ctx ? activityHeight(props.item, ctx) : h())}px`;
  };
  return (
    <div
      class={activityRoot}
      data-activity
      data-activity-id={props.item.id}
      role="note"
      aria-label="Agent activity"
      style={{ color: activityColor(props.item), height: height(), overflow: 'hidden' }}
    >
      <ActivityHeader item={props.item} expanded={expanded()} height={h()} />
      <Show when={body()}>
        {(node) => (
          <div style={{ overflow: 'hidden', width: '100%' }}>
            <BlockStackView node={node()} />
          </div>
        )}
      </Show>
    </div>
  );
}

function groupHeight(item: ActivityGroupItem, ctx: MeasureCtx): number {
  return (
    headerHeight(ctx) +
    (ctx.expanded(item.id)
      ? item.events.reduce((height, event) => height + activityHeight(event, ctx), 0)
      : 0)
  );
}

function ActivityGroupRender(props: { data: ActivityGroupItem; ctx: RenderCtx }): JSX.Element {
  const theme = useTheme();
  const expanded = () => props.ctx.viewState.isCollapsed(props.data.id);
  const height = () => {
    const ctx = props.ctx.measureCtx?.();
    return `${props.ctx.clipHeight?.() ?? (ctx ? groupHeight(props.data, ctx) : 0)}px`;
  };
  return (
    <div data-activity-group style={{ color: vars.fgMuted, height: height(), overflow: 'hidden' }}>
      <CollapseHeader
        keyboard
        id={props.data.id}
        expanded={expanded()}
        height={theme().fonts.body.lineHeight + HEADER_ROW_EXTRA_H}
      >
        {props.data.events.length} completed events
      </CollapseHeader>
      <Show when={expanded()}>
        <For each={props.data.events}>
          {(event) => <ActivityRender item={event} ctx={props.ctx} nested />}
        </For>
      </Show>
    </div>
  );
}

export const activityGroupUnitDef = defineUnit<ActivityGroupItem, Record<string, never>>({
  kind: 'activity-group',
  margin: { top: 2, bottom: 2 },
  vars: {},
  collapseIds: (item) => [item.id, ...item.events.map((event) => event.id)],
  measure: groupHeight,
  Render: ActivityGroupRender,
});

export const activityUnitDef = defineUnit<Notification, Record<string, never>>({
  kind: 'activity',
  margin: { top: 2, bottom: 2 },
  vars: {},
  collapseIds: (item) => [item.id],
  measure: activityHeight,
  Render: (props) => <ActivityRender item={props.data} ctx={props.ctx} />,
});
