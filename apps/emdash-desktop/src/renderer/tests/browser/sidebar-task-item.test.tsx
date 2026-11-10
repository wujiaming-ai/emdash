import '@emdash/ui/style.css';
import '@renderer/index.css';
import '@fontsource-variable/inter/index.css';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { icon as claudeIcon } from '../../../../../../packages/plugins/src/agents/impl/claude/icon';
import { icon as codexIcon } from '../../../../../../packages/plugins/src/agents/impl/codex/icon';

const state = vi.hoisted(() => ({
  task: {
    state: 'provisioned',
    data: {
      id: 'task',
      projectId: 'project',
      name: '很长的任务标题 cli-framework 回归验证',
      conversations: { codex: 1 },
    },
    isBootstrapping: false,
  },
  stats: { codex: 1 } as Record<string, number>,
  theme: 'emlight',
  navigate: vi.fn(),
}));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskStore: () => state.task,
  getTaskManagerStore: () => ({}),
}));
vi.mock('@core/features/conversations/api/browser/conversation-selectors', () => ({
  taskConversationStats: () => state.stats,
}));
vi.mock('@core/features/agents/api/browser/use-agent-metadata', () => ({
  useAgentMetadata: () => ({
    data: [
      { id: 'codex', name: 'Codex' },
      { id: 'claude', name: 'Claude Code' },
    ],
  }),
  useAgentIcon: (id: string) => (id === 'codex' ? codexIcon : id === 'claude' ? claudeIcon : null),
}));
vi.mock('@core/primitives/theme/browser', () => ({
  useTheme: () => ({ effectiveTheme: state.theme }),
}));
vi.mock('@core/features/tasks/contributions/browser/task-context-menu', () => ({
  TaskContextMenu: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@core/manifests/browser/modal-api', () => ({ useOpenModal: () => vi.fn() }));
vi.mock('@core/primitives/navigation/browser/navigation-hooks', () => ({
  useNavigate: () => ({ navigate: state.navigate }),
  useViewParams: () => ({ taskId: 'task', projectId: 'project' }),
  useWorkspaceSlots: () => ({ currentView: 'task' }),
}));
vi.mock('@core/features/settings/api/browser/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({
    value: { showLeftSidebarLineChanges: false, showLeftSidebarPrStatus: false },
  }),
}));
vi.mock('@core/features/source-control/api/browser/stores/task-source-control-selectors', () => ({
  getTaskGitCheckoutStore: () => null,
  getTaskPrAssociationStore: () => ({ pullRequests: [] }),
}));
vi.mock('@core/features/workbench/api/browser/task-composition-selectors', () => ({
  getTaskWorkspace: () => null,
}));
vi.mock('@core/features/workbench/browser/sidebar/task-sidebar-agent-status', () => ({
  TaskSidebarTrailingSlot: () => <span data-testid="timestamp">6m</span>,
}));
import { StackedAgentLogos } from '@core/features/agents/contributions/browser/stacked-agent-logos';
import { SidebarTaskItem } from '@core/features/workbench/browser/sidebar/task-item';

let container: HTMLDivElement;
let root: Root;
let revision = 0;
beforeEach(() => {
  state.stats = { codex: 1 };
  state.theme = 'emlight';
  state.navigate.mockClear();
  container = document.createElement('div');
  container.style.width = '240px';
  container.style.background = 'var(--color-background)';
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});
function render(variant: 'underProject' | 'pinned' = 'underProject'): void {
  container.className = `${state.theme} font-sans text-sm`;
  revision++;
  flushSync(() =>
    root.render(
      <SidebarTaskItem key={revision} projectId="project" taskId="task" rowVariant={variant} />
    )
  );
}

it.each(['emlight', 'emdark'])('uses existing logos with compact layout in %s', async (theme) => {
  state.theme = theme;
  render();
  const svg = container.querySelector('svg')!;
  expect(svg).not.toBeNull();
  const tile = container.querySelector('[title="Codex"]')!;
  expect(getComputedStyle(tile).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(getComputedStyle(tile).boxShadow).toBe('none');
  const logo = svg.getBoundingClientRect();
  expect(logo.width).toBe(14);
  expect(logo.height).toBe(14);
  const row = container.querySelector('[data-active]')!;
  expect(row.getBoundingClientRect().height).toBe(32);
  const title = container.querySelector('.truncate')!;
  expect(title.getBoundingClientRect().left).toBeGreaterThan(logo.right);
  expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
  expect(container.scrollWidth).toBe(container.clientWidth);
  await page.screenshot({ element: container, path: `__screenshots__/sidebar-agent-${theme}.png` });
  await page.getByRole('button', { name: `Open task ${state.task.data.name}` }).click();
  expect(state.navigate).toHaveBeenCalledOnce();
});
it.each(['emlight', 'emdark'])('separates multiple agents without a frame in %s', async (theme) => {
  state.theme = theme;
  state.stats = { codex: 2, claude: 1 };
  render('pinned');
  expect(container.querySelectorAll('svg')).toHaveLength(2);
  const codex = container.querySelector('[title="Codex: 2"]')!;
  const claude = container.querySelector('[title="Claude Code"]')!;
  expect(codex.lastElementChild?.textContent).toBe('2');
  expect(claude.getBoundingClientRect().left).toBeGreaterThan(codex.getBoundingClientRect().right);
  for (const tile of [codex, claude]) {
    expect(getComputedStyle(tile).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(tile).boxShadow).toBe('none');
  }
  expect(container.scrollWidth).toBe(container.clientWidth);
  await page.screenshot({
    element: container,
    path: `__screenshots__/sidebar-multiple-agents-${theme}.png`,
  });
  state.stats = {};
  render('pinned');
  expect(container.querySelectorAll('svg')).toHaveLength(0);
  expect(container.textContent).toContain(state.task.data.name);
});

it('keeps the default stacked cards for other consumers', () => {
  container.className = 'emlight';
  flushSync(() => root.render(<StackedAgentLogos stats={{ codex: 1, claude: 1 }} />));
  const tile = container.querySelector('[title="Codex"]')!;
  expect(getComputedStyle(tile).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(getComputedStyle(tile).boxShadow).not.toBe('none');
});
