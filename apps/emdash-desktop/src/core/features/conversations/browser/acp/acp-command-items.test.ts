import type { CommandItem } from '@emdash/ui/react/components';
import { describe, expect, it } from 'vitest';
import { selectAgentCommandItems } from './acp-command-items';

const commands: CommandItem[] = [
  { id: 'status', name: 'status', description: 'Session status', behavior: 'insert' },
  { id: '$review', name: '$review', description: 'Review code', behavior: 'insert' },
];

describe('agent command menus', () => {
  it('separates Codex skills while keeping native command and skill identities', () => {
    expect(selectAgentCommandItems(commands, 'codex', '/', '').map((item) => item.name)).toEqual([
      'status',
    ]);
    expect(selectAgentCommandItems(commands, 'codex', '$', 'CODE')).toEqual([
      { ...commands[1], name: 'review', prefix: '$', section: 'Skills' },
    ]);
  });

  it('keeps Claude builtins and manually callable skills together', () => {
    const claude = [commands[0], { ...commands[1], id: 'review', name: 'review' }];
    expect(selectAgentCommandItems(claude, 'claude', '/', '').map((item) => item.name)).toEqual([
      'status',
      'review',
    ]);
    expect(selectAgentCommandItems(claude, 'claude', '$', '')).toEqual([]);
  });

  it.each(['opencode', 'gemini', 'auggie', null])(
    'preserves %s command names and behavior',
    (provider) => {
      expect(selectAgentCommandItems(commands, provider, '/', '')).toEqual(
        commands.map((command) => ({ ...command, section: 'Commands' }))
      );
      expect(selectAgentCommandItems(commands, provider, '$', '')).toEqual([]);
    }
  );

  it('uses only the supplied session catalog, including refreshed and empty catalogs', () => {
    expect(selectAgentCommandItems(commands, 'codex', '$', '')).toHaveLength(1);
    const remote = [{ id: '$deploy', name: '$deploy', behavior: 'insert' as const }];
    expect(selectAgentCommandItems(remote, 'codex', '$', '').map((item) => item.name)).toEqual([
      'deploy',
    ]);
    expect(selectAgentCommandItems([], 'codex', '$', '')).toEqual([]);
    expect(selectAgentCommandItems(commands, 'codex', '$', 'missing')).toEqual([]);
  });
});
