import type { ResourceUri } from '@emdash/core/primitives/path/api';
import { deferred } from '@emdash/shared/testing';
import { Dialog } from '@emdash/ui/react/primitives';
import { LiveJobFailedError } from '@emdash/wire/live';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ModalHostTestProvider } from '@core/primitives/modals/react';
import type { DownloadProgress } from '../api/downloads';
import { DownloadDialog } from './download-dialog';
import '@fontsource-variable/inter/index.css';
import '@emdash/ui/style.css';

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), discard: vi.fn(), run: vi.fn() }));
vi.mock('../api/browser/client', () => ({
  getFilesClient: async () => ({ downloads: { prepare: mocks.prepare, discard: mocks.discard } }),
}));
vi.mock('./download-runner', () => ({ runDownload: mocks.run }));
let host: HTMLDivElement;
let root: Root;
const dismiss = vi.fn();
const guard = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mocks.prepare.mockResolvedValue({ id: 'download', destination: '/Users/test/Downloads' });
  mocks.discard.mockResolvedValue(undefined);
  await act(async () =>
    root.render(
      <Dialog.Root open>
        <Dialog.Content size="sm">
          <ModalHostTestProvider
            id="downloadFilesModal"
            controller={{
              dismiss,
              complete: vi.fn(),
              setCloseGuard: guard,
              hasActiveCloseGuard: false,
            }}
          >
            <DownloadDialog
              sources={[
                'emdash-file://v2/remote/test/posix/work/Remotion-HyperFrames-Skills.zip' as ResourceUri,
              ]}
            />
          </ModalHostTestProvider>
        </Dialog.Content>
      </Dialog.Root>
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.documentElement.classList.remove('emlight', 'emdark');
  await page.viewport(1280, 800);
});
const progress: DownloadProgress = {
  path: 'folder/中文 文件.bin',
  bytes: 4,
  size: 10,
  files: 0,
  transferred: 4,
  skipped: 0,
  warnings: [],
};

it('shows progress, pauses, resumes and completes without creating a second destination', async () => {
  const first = deferred<DownloadProgress>();
  mocks.run
    .mockImplementationOnce(
      (_client, _id, signal: AbortSignal, update: (value: DownloadProgress) => void) => {
        update(progress);
        signal.addEventListener('abort', () =>
          first.reject(new DOMException('Paused', 'AbortError'))
        );
        return first.promise;
      }
    )
    .mockResolvedValueOnce({ ...progress, bytes: 10, files: 1 });
  await page.getByRole('button', { name: 'Choose destination…' }).click();
  await expect.element(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  expect(guard).toHaveBeenCalledWith(true);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.element(page.getByText('Download paused', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.element(page.getByText('Download complete', { exact: true })).toBeVisible();
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  expect(mocks.prepare.mock.calls[0][0].conflict).toBe('keep-both');
  expect(mocks.prepare.mock.calls[0][1]).toEqual({ timeoutMs: 0 });
});

it('keeps a recoverable error visible and allows discarding partial files', async () => {
  mocks.run.mockRejectedValue(new Error('Source changed; restart the download'));
  await page.getByRole('button', { name: 'Choose destination…' }).click();
  await expect.element(page.getByRole('alert')).toHaveTextContent('Source changed');
  await page.getByRole('button', { name: 'Discard partial download' }).click();
  expect(mocks.discard).toHaveBeenCalledWith({ id: 'download' });
  expect(dismiss).toHaveBeenCalled();
});

it('returns to ready when the native destination chooser is cancelled', async () => {
  mocks.prepare.mockResolvedValue(null);
  await page.getByRole('button', { name: 'Choose destination…' }).click();
  await expect.element(page.getByRole('button', { name: 'Choose destination…' })).toBeVisible();
  expect(mocks.run).not.toHaveBeenCalled();
});

it('keeps long paths and recovery actions inside a narrow dialog', async () => {
  await page.viewport(420, 800);
  mocks.prepare.mockResolvedValue({
    id: 'download',
    destination: '/Users/test/' + 'long-folder-'.repeat(25),
  });
  mocks.run.mockRejectedValue(new Error('A long transfer failure: ' + 'details '.repeat(30)));
  await page.getByRole('button', { name: 'Choose destination…' }).click();
  await expect.element(page.getByRole('alert')).toBeVisible();
  const dialog = document.querySelector('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) throw new Error('No dialog');
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
  for (const button of dialog.querySelectorAll('button')) {
    const rect = button.getBoundingClientRect();
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(rect.left).toBeGreaterThanOrEqual(0);
  }
  await page.viewport(1280, 800);
});

it('shows a fallback error for an unexpected job failure without typed details', async () => {
  mocks.run.mockRejectedValue(new LiveJobFailedError(undefined));
  await page.getByRole('button', { name: 'Choose destination…' }).click();
  await expect.element(page.getByRole('alert')).toHaveTextContent('Live job failed');
  await expect.element(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
});

it('uses the shared conflict control and keeps recovery help collapsed', async () => {
  await expect
    .element(page.getByRole('combobox', { name: 'If a file already exists' }))
    .toBeVisible();
  await expect
    .element(page.getByRole('button', { name: 'About downloads' }))
    .toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('combobox', { name: 'If a file already exists' }).click();
  await page.getByRole('option', { name: 'Skip existing files', exact: true }).click();
  mocks.prepare.mockResolvedValue(null);
  await page.getByRole('button', { name: 'Choose destination…' }).click();
  expect(mocks.prepare.mock.calls[0][0].conflict).toBe('skip');
});

it('shows a compact completed summary with total bytes instead of the last file progress', async () => {
  mocks.run.mockResolvedValue({ ...progress, bytes: 10, transferred: 2048, files: 1 });
  await page.getByRole('button', { name: 'Choose destination…' }).click();
  await expect.element(page.getByText('1 file · 2.0 KB downloaded')).toBeVisible();
  await expect.element(page.getByRole('progressbar')).not.toBeInTheDocument();
  await expect.element(page.getByText('Saved to', { exact: true })).toBeVisible();
});

it.each(['emlight', 'emdark'])('keeps %s states compact using shared controls', async (theme) => {
  document.documentElement.classList.add(theme);
  await page.viewport(960, 720);
  await document.fonts.ready;
  const dialog = page.getByRole('dialog');
  await expect.element(page.getByText('Remotion-HyperFrames-Skills.zip')).toBeVisible();
  const bounds = dialog.element().getBoundingClientRect();
  expect(bounds.width).toBeLessThanOrEqual(384);
  expect(bounds.height).toBeLessThan(350);
  await page.screenshot({ element: dialog, path: `__screenshots__/download-ready-${theme}.png` });
  const running = deferred<DownloadProgress>();
  mocks.run.mockImplementationOnce((_client, _id, _signal, update) => {
    update(progress);
    return running.promise;
  });
  await page.getByRole('button', { name: 'Choose destination…' }).click();
  await expect.element(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  expect(
    page.getByRole('progressbar').element().getBoundingClientRect().height
  ).toBeLessThanOrEqual(6);
  await page.screenshot({ element: dialog, path: `__screenshots__/download-running-${theme}.png` });
  await act(async () => running.resolve({ ...progress, bytes: 10, transferred: 10, files: 1 }));
  await expect.element(page.getByText('Download complete', { exact: true })).toBeVisible();
  await page.screenshot({
    element: dialog,
    path: `__screenshots__/download-complete-${theme}.png`,
  });
});

it('reveals recovery guidance and skipped details without crowding the summary', async () => {
  const help = page.getByRole('button', { name: 'About downloads' });
  (help.element() as HTMLElement).focus();
  await userEvent.keyboard('{Enter}');
  await expect.element(help).toHaveAttribute('aria-expanded', 'true');
  await expect.element(page.getByText('Pause and resume anytime.', { exact: false })).toBeVisible();
  mocks.run.mockResolvedValue({
    ...progress,
    bytes: 10,
    transferred: 10,
    files: 2,
    skipped: 1,
    warnings: ['Skipped symbolic link: folder/link'],
  });
  await page.getByRole('button', { name: 'Choose destination…' }).click();
  await expect.element(page.getByText('2 files · 10 B downloaded · 1 skipped')).toBeVisible();
  await page.getByRole('button', { name: 'Skipped items' }).click();
  await expect.element(page.getByText('Skipped symbolic link: folder/link')).toBeVisible();
});
