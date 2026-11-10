import { useAgentMetadata } from '@core/features/agents/api/browser/use-agent-metadata';
import { AgentIcon } from '@core/features/agents/contributions/browser/agent-icon';
import { cn } from '@core/primitives/styling/browser/cn';

interface StackedAgentLogosProps {
  /** Map of providerId to conversation count, same shape as task.conversationStats */
  stats: Record<string, number>;
  /** 侧栏只显示原图，其他页面保留叠放卡片。 */
  appearance?: 'stacked' | 'plain';
}

export function StackedAgentLogos({ stats, appearance = 'stacked' }: StackedAgentLogosProps) {
  const entries = Object.entries(stats);
  const { data: agents } = useAgentMetadata();
  if (entries.length === 0) return null;

  const nameMap = new Map((agents ?? []).map((a) => [a.id, a.name]));

  return (
    <div
      className={cn(
        'flex shrink-0 items-center',
        appearance === 'plain'
          ? 'gap-1'
          : '[&>span]:ring-2 [&>span]:ring-background [&>span:not(:first-child)]:-ml-1.5'
      )}
    >
      {entries.map(([providerId, count]) => {
        const name = nameMap.get(providerId) ?? providerId;
        return (
          <span
            key={providerId}
            className={cn(
              'relative flex h-5 w-5 items-center justify-center overflow-hidden',
              appearance === 'stacked' && 'rounded-sm bg-background-2'
            )}
            title={count > 1 ? `${name}: ${String(count)}` : name}
          >
            <AgentIcon id={providerId} size={14} />
            {count > 1 && (
              <span
                className={cn(
                  'absolute -right-px -bottom-px px-px text-[8px] leading-none font-semibold text-foreground-passive',
                  appearance === 'stacked' && 'rounded-tl bg-background'
                )}
              >
                {count}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
