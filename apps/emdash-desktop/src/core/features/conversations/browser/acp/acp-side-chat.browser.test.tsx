import { ThemeProvider } from '@emdash/ui/react/primitives';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { AcpSideChatLayout } from './acp-side-chat';
import '@fontsource-variable/inter/index.css';
import '@emdash/ui/style.css';

let host: HTMLDivElement;
let root: Root;
const request = vi.fn();
const add = vi.fn();
async function render(
  enabled = true,
  key = 'one',
  theme: 'light' | 'dark' = 'light'
): Promise<void> {
  await act(async () =>
    root.render(
      <ThemeProvider theme={theme}>
        <div style={{ height: 680, width: '100%' }}>
          <AcpSideChatLayout
            key={key}
            enabled={enabled}
            renderSide={({ quote, onClose }) => (
              <aside aria-label="Side chat" className="h-full p-4">
                <p>{quote}</p>
                <button onClick={onClose}>Close side chat</button>
              </aside>
            )}
            onAddToConversation={add}
          >
            <div className="surface-paper h-full p-8">
              <p data-block-id="message#1">
                <span>The main task is still running.</span>
              </p>
              <textarea aria-label="Main draft" />
            </div>
          </AcpSideChatLayout>
        </div>
      </ThemeProvider>
    )
  );
}
async function select(): Promise<void> {
  await act(async () => {
    const node = host.querySelector('[data-block-id]');
    if (!node) throw new Error('No main message');
    const range = document.createRange();
    range.selectNodeContents(node);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}
async function openSide(): Promise<void> {
  await select();
  await page.getByRole('button', { name: 'Ask in side chat' }).click();
}
beforeEach(async () => {
  vi.clearAllMocks();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  request.mockResolvedValue({ success: true, data: { text: 'This is an isolated answer.' } });
  await page.viewport(1280, 800);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.getSelection()?.removeAllRanges();
  document.documentElement.classList.remove('emlight', 'emdark');
  await page.viewport(1280, 800);
});

it('keeps selection actions after the release click and lets the user open side chat', async () => {
  await select();
  await expect.element(page.getByRole('button', { name: 'Ask in side chat' })).toBeVisible();
  // 拖选结束后的 click 不会折叠选区，必须经过真实 Popover 的外部点击处理。
  await act(async () => {
    host
      .querySelector('[data-block-id]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await expect.element(page.getByRole('button', { name: 'Ask in side chat' })).toBeVisible();
  await page.getByRole('button', { name: 'Ask in side chat' }).click();
  await expect.element(page.getByRole('complementary', { name: 'Side chat' })).toBeVisible();
  expect(request).not.toHaveBeenCalled();
});

it('keeps selection actions after a native double click', async () => {
  await page.getByText('The main task is still running.', { exact: true }).dblClick();
  expect(window.getSelection()?.isCollapsed).toBe(false);
  await expect.element(page.getByRole('button', { name: 'Add to conversation' })).toBeVisible();
  const selected = window.getSelection()?.toString().trim();
  await page.getByRole('button', { name: 'Add to conversation' }).click();
  expect(add).toHaveBeenCalledExactlyOnceWith(selected);
  expect(request).not.toHaveBeenCalled();
});

it('still dismisses on outside clicks even if the selected text remains', async () => {
  await select();
  await expect.element(page.getByRole('button', { name: 'Ask in side chat' })).toBeVisible();
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(window.getSelection()?.isCollapsed).toBe(false);
  await expect
    .element(page.getByRole('button', { name: 'Ask in side chat' }))
    .not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});

it('still dismisses on Escape, selection clearing and transcript scrolling', async () => {
  await select();
  await userEvent.keyboard('{Escape}');
  await expect
    .element(page.getByRole('button', { name: 'Ask in side chat' }))
    .not.toBeInTheDocument();
  await select();
  await act(async () => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect
    .element(page.getByRole('button', { name: 'Ask in side chat' }))
    .not.toBeInTheDocument();
  await select();
  await act(async () => {
    host.querySelector('[data-block-id]')?.dispatchEvent(new Event('scroll'));
  });
  await expect
    .element(page.getByRole('button', { name: 'Ask in side chat' }))
    .not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});

it('puts a selection into the draft without creating a side request', async () => {
  await select();
  await page.getByRole('button', { name: 'Add to conversation' }).click();
  expect(add).toHaveBeenCalledExactlyOnceWith('The main task is still running.');
  expect(request).not.toHaveBeenCalled();
});

it('does not expose side actions for agents without the negotiated capability', async () => {
  await render(false);
  await select();
  await expect
    .element(page.getByRole('button', { name: 'Ask in side chat' }))
    .not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
});

it.each(['emlight', 'emdark'])(
  'keeps controls visible in narrow layouts and %s theme',
  async (theme) => {
    await render(true, 'one', theme === 'emdark' ? 'dark' : 'light');
    await page.viewport(480, 800);
    await openSide();

    const panel = host.querySelector('aside');
    if (!(panel instanceof HTMLElement)) throw new Error('Missing side panel');
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    for (const button of panel.querySelectorAll('button')) {
      const rect = button.getBoundingClientRect();
      expect(rect.right).toBeLessThanOrEqual(480);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(panel.getBoundingClientRect().bottom + 1);
      expect(rect.top).toBeGreaterThanOrEqual(panel.getBoundingClientRect().top);
    }
    await page.screenshot({ path: `__screenshots__/side-chat-${theme}-narrow.png` });
  }
);

it('uses a resizable side panel and selection toolbar at desktop width', async () => {
  await select();
  await expect.element(page.getByRole('button', { name: 'Ask in side chat' })).toBeVisible();
  await page.screenshot({ path: '__screenshots__/side-chat-selection.png' });
  await page.getByRole('button', { name: 'Ask in side chat' }).click();

  const panel = host.querySelector('aside');
  const main = host.querySelector('[data-block-id]');
  if (!(panel instanceof HTMLElement) || !(main instanceof HTMLElement))
    throw new Error('Missing panels');
  expect(panel.getBoundingClientRect().left).toBeGreaterThan(main.getBoundingClientRect().right);
  await page.screenshot({ path: '__screenshots__/side-chat-desktop.png' });
  await page.getByRole('button', { name: 'Close side chat' }).click();

  await expect.element(page.getByRole('textbox', { name: 'Main draft' })).toBeVisible();
});
