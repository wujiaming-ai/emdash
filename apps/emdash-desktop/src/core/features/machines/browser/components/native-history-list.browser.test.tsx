import '@emdash/ui/style.css';
import type { NativeSession } from '@emdash/core/runtimes/acp/api/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

const api = vi.hoisted(() => ({ list: vi.fn(), open: vi.fn(), navigate: vi.fn() }));
vi.mock('@core/features/conversations/api/browser/client', () => ({
  getConversationsClient: async () => ({ nativeHistory: api }),
}));
vi.mock('@core/primitives/navigation/browser/navigation-hooks', () => ({
  useNavigate: () => ({ navigate: api.navigate }),
}));
vi.mock('../open-native-history', () => ({
  openNativeHistoryLocation: async (location: unknown, navigate: (value: unknown) => void) =>
    navigate(location),
}));
import { NativeHistoryList } from './native-history-list';

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
const session = (id: string): NativeSession => ({
  sessionId: id,
  selectionId: `selection-${id}`,
  providerId: 'codex',
  title: `Task ${id}`,
  cwd: `/original/${id}`,
  updatedAt: null,
});
beforeEach(() => {
  vi.resetAllMocks();
  api.open.mockResolvedValue({
    projectId: 'project',
    taskId: 'task',
    conversationId: 'conversation',
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  container.style.width = '700px';
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  client.clear();
  container.remove();
});
function render(reachable = true): void {
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <NativeHistoryList
          scope={{ kind: 'remote', connectionId: 'devbox' }}
          providerId="codex"
          hostReachable={reachable}
        />
      </QueryClientProvider>
    )
  );
}

it('loads another page only after Show more, retaining old rows and deduplicating overlaps', async () => {
  api.list.mockResolvedValueOnce({ sessions: [session('one')], nextCursor: 'page-2' });
  api.list.mockResolvedValueOnce({ sessions: [session('one'), session('two')], nextCursor: null });
  render();
  await expect.element(page.getByText('Task one', { exact: true })).toBeVisible();
  expect(api.list).toHaveBeenCalledTimes(1);
  await page.getByRole('button', { name: 'Show more', exact: true }).click();
  await expect.element(page.getByText('Task two', { exact: true })).toBeVisible();
  expect(api.list.mock.calls[1]?.[0]).toMatchObject({ providerId: 'codex', cursor: 'page-2' });
  expect(container.textContent?.match(/Task one/g)).toHaveLength(1);
  await expect
    .element(page.getByRole('button', { name: 'Show more', exact: true }))
    .not.toBeInTheDocument();
});

it('keeps loaded rows after a page error and retries the same cursor', async () => {
  api.list.mockResolvedValueOnce({ sessions: [session('one')], nextCursor: 'page-2' });
  api.list.mockRejectedValueOnce(new Error('Host disconnected'));
  api.list.mockResolvedValueOnce({ sessions: [session('two')], nextCursor: null });
  render();
  await page.getByRole('button', { name: 'Show more', exact: true }).click();
  await expect.element(page.getByText('Task one', { exact: true })).toBeVisible();
  await expect.element(page.getByRole('alert')).toHaveTextContent('Host disconnected');
  await page.getByRole('button', { name: 'Retry loading more', exact: true }).click();
  await expect.element(page.getByText('Task two', { exact: true })).toBeVisible();
  expect(api.list.mock.calls[2]?.[0]).toMatchObject({ cursor: 'page-2' });
});

it('opens the selected host record and does not fetch while the host is offline', async () => {
  render(false);
  expect(api.list).not.toHaveBeenCalled();
  api.list.mockResolvedValueOnce({ sessions: [session('one')], nextCursor: null });
  render(true);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await vi.waitFor(() => expect(api.open).toHaveBeenCalledOnce());
  expect(api.open.mock.calls[0]?.[0]).toMatchObject({ selectionId: 'selection-one' });
  expect(api.open.mock.calls[0]?.[0].host).toBe(api.list.mock.calls[0]?.[0].host);
  await vi.waitFor(() => expect(api.navigate).toHaveBeenCalledOnce());
});

it('refreshes from the first page and presents a bounded batch with existing list styles', async () => {
  await page.viewport(900, 1600);
  api.list.mockResolvedValueOnce({
    sessions: Array.from({ length: 20 }, (_, i) => session(String(i + 1))),
    nextCursor: 'page-2',
  });
  api.list.mockResolvedValueOnce({ sessions: [session('fresh')], nextCursor: null });
  render();
  await expect.element(page.getByText('Task 20', { exact: true })).toBeVisible();
  await expect.element(page.getByRole('button', { name: 'Show more', exact: true })).toBeVisible();
  await page.screenshot({
    path: '__screenshots__/native-history.png',
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.element(page.getByText('Task fresh', { exact: true })).toBeVisible();
  expect(api.list.mock.calls[1]?.[0].cursor).toBeNull();
  await expect.element(page.getByText('Task 1', { exact: true })).not.toBeInTheDocument();
});
