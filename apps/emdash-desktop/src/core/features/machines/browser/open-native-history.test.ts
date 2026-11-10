import { observable, runInAction } from 'mobx';
import { afterEach, expect, it, vi } from 'vitest';
import type { NavigateFnTyped } from '@core/primitives/navigation/browser/navigation-hooks';

const stores = vi.hoisted(() => ({ project: vi.fn(), task: vi.fn(), composition: vi.fn() }));
vi.mock('@core/features/projects/api/browser/stores/project-selectors', () => ({
  getProjectManagerStore: stores.project,
}));
vi.mock('@core/features/tasks/api/browser/task-state/task-selectors', () => ({
  getTaskStore: stores.task,
}));
vi.mock('@core/features/workbench/api/browser/task-composition-selectors', () => ({
  getTaskComposition: stores.composition,
}));
vi.mock('@core/features/tasks/contributions/views', () => ({
  taskViewDef: (input: unknown) => input,
}));
import { openNativeHistoryLocation } from './open-native-history';

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('waits for project and task hydration before navigation and opens the exact conversation', async () => {
  const state = observable({ project: false, task: false, composition: false });
  const open = vi.fn(async () => {});
  const hydrate = vi.fn(async () => {});
  stores.project.mockImplementation(() => ({
    projects: { has: () => state.project },
    hydrateProjectContext: hydrate,
  }));
  stores.task.mockImplementation(() => (state.task ? {} : undefined));
  stores.composition.mockImplementation(() =>
    state.composition ? { openConversation: open } : undefined
  );
  const navigate = vi.fn();
  const pending = openNativeHistoryLocation(
    { projectId: 'p', taskId: 't', conversationId: 'c' },
    navigate as NavigateFnTyped
  );
  expect(hydrate).not.toHaveBeenCalled();
  runInAction(() => {
    state.project = true;
  });
  await vi.waitFor(() => expect(hydrate).toHaveBeenCalledWith('p'));
  expect(navigate).not.toHaveBeenCalled();
  runInAction(() => {
    state.task = true;
  });
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ projectId: 'p', taskId: 't' }));
  expect(open).not.toHaveBeenCalled();
  runInAction(() => {
    state.composition = true;
  });
  await pending;
  expect(open).toHaveBeenCalledExactlyOnceWith('c');
});

it('fails visibly instead of navigating when the imported project never arrives', async () => {
  vi.useFakeTimers();
  stores.project.mockReturnValue({ projects: new Map() });
  const navigate = vi.fn();
  const pending = openNativeHistoryLocation(
    { projectId: 'p', taskId: 't', conversationId: 'c' },
    navigate as NavigateFnTyped
  );
  const rejected = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(navigate).not.toHaveBeenCalled();
});
