import type { CommandItem } from '@emdash/ui/react/components';

/** 使用当前会话的候选；不读取本机目录或跨主机合并 Skill。 */
export function selectAgentCommandItems(
  commands: readonly CommandItem[],
  providerId: string | null,
  trigger: '/' | '$',
  query: string
): CommandItem[] {
  if (trigger === '$' && providerId !== 'codex') return [];
  const normalized = query.trim().toLowerCase();
  return commands
    .filter((command) => {
      if (providerId !== 'codex') return true;
      return command.name.startsWith('$') === (trigger === '$');
    })
    .map((command) =>
      trigger === '$'
        ? { ...command, name: command.name.slice(1), prefix: '$' as const, section: 'Skills' }
        : { ...command, section: 'Commands' }
    )
    .filter(
      (command) =>
        !normalized ||
        [command.name, command.label, command.description].some((value) =>
          value?.toLowerCase().includes(normalized)
        )
    );
}
