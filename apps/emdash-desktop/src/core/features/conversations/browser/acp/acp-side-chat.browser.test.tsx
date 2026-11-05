import { deferred } from '@emdash/shared/testing';
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
const client = { sideQuestion: request };
async function render(
  enabled = true,
  key = 'one',
  theme: 'light' | 'dark' = 'light'
): Promise<void> {
  await act(async () =>
    root.render(
      <ThemeProvider theme={theme}>
        <div style={{ height: 680, width: '100%' }}>
          <AcpSideChatLayout key={key} client={enabled ? client : null} onAddToConversation={add}>
            <div className="surface-paper h-full p-8">
              <p data-block-id="message#1">The main task is still running.</p>
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

it('opens from selected text, asks follow-ups and only adds an answer on explicit action', async () => {
  await openSide();
  await expect.element(page.getByRole('complementary', { name: 'Side chat' })).toBeVisible();
  await expect.element(page.getByRole('textbox', { name: 'Side question' })).toHaveFocus();
  await page.getByRole('textbox', { name: 'Side question' }).fill('Explain this');
  await page.getByRole('button', { name: 'Send side question' }).click();
  await expect
    .element(page.getByText('This is an isolated answer.', { exact: true }))
    .toBeVisible();
  expect(request.mock.calls[0][0]).toMatchObject({
    action: 'ask',
    question: 'Explain this',
    quote: 'The main task is still running.',
  });
  expect(add).not.toHaveBeenCalled();
  await page.getByRole('button', { name: 'Add to conversation' }).click();
  expect(add).toHaveBeenCalledExactlyOnceWith('This is an isolated answer.');
  await page.getByRole('textbox', { name: 'Side question' }).fill('Why?');
  await page.getByRole('button', { name: 'Send side question' }).click();
  expect(request.mock.calls[1][0]).toMatchObject({
    sideId: request.mock.calls[0][0].sideId,
    question: 'Why?',
    quote: undefined,
  });
});

it('puts a selection into the draft without creating a side request', async () => {
  await select();
  await page.getByRole('button', { name: 'Add to conversation' }).click();
  expect(add).toHaveBeenCalledExactlyOnceWith('The main task is still running.');
  expect(request).not.toHaveBeenCalled();
});

it('cancels the side request and suppresses its late answer', async () => {
  const answer = deferred<unknown>();
  request.mockImplementation((input) =>
    input.action === 'ask' ? answer.promise : Promise.resolve({ success: true, data: { text: '' } })
  );
  await openSide();
  await page.getByRole('textbox', { name: 'Side question' }).fill('Long question');
  await page.getByRole('button', { name: 'Send side question' }).click();
  await page.getByRole('button', { name: 'Stop side answer' }).click();
  expect(request.mock.calls[1][0]).toMatchObject({
    action: 'cancel',
    sideId: request.mock.calls[0][0].sideId,
  });
  await act(async () => answer.resolve({ success: true, data: { text: 'late answer' } }));
  await expect.element(page.getByText('late answer')).not.toBeInTheDocument();
  await expect.element(page.getByRole('button', { name: 'Send side question' })).toBeVisible();
});

it('closes and isolates state when switching conversations during a request', async () => {
  const answer = deferred<unknown>();
  request.mockImplementation((input) =>
    input.action === 'ask' ? answer.promise : Promise.resolve({ success: true, data: { text: '' } })
  );
  await openSide();
  await page.getByRole('textbox', { name: 'Side question' }).fill('Question');
  await page.getByRole('button', { name: 'Send side question' }).click();
  await render(true, 'two');
  expect(request.mock.calls[1][0]).toMatchObject({
    action: 'close',
    sideId: request.mock.calls[0][0].sideId,
  });
  await act(async () => answer.resolve({ success: true, data: { text: 'old answer' } }));
  await expect
    .element(page.getByRole('complementary', { name: 'Side chat' }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText('old answer')).not.toBeInTheDocument();
});

it('shows request errors and permits retry without submitting to the main conversation', async () => {
  request.mockResolvedValueOnce({ success: false, error: { message: 'Side service unavailable' } });
  await openSide();
  await page.getByRole('textbox', { name: 'Side question' }).fill('Question');
  await page.getByRole('button', { name: 'Send side question' }).click();
  await expect.element(page.getByRole('alert')).toHaveTextContent('Side service unavailable');
  await page.getByRole('textbox', { name: 'Side question' }).fill('Try again');
  await page.getByRole('button', { name: 'Send side question' }).click();
  await expect.element(page.getByText('This is an isolated answer.')).toBeVisible();
  expect(add).not.toHaveBeenCalled();
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
    await page
      .getByRole('textbox', { name: 'Side question' })
      .fill('中文问题 ' + 'long-question-'.repeat(30));
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
  await page
    .getByRole('textbox', { name: 'Side question' })
    .fill('How does this stay separate from the main task?');
  await page.getByRole('button', { name: 'Send side question' }).click();
  await expect.element(page.getByText('This is an isolated answer.')).toBeVisible();
  const panel = host.querySelector('aside');
  const main = host.querySelector('[data-block-id]');
  if (!(panel instanceof HTMLElement) || !(main instanceof HTMLElement))
    throw new Error('Missing panels');
  expect(panel.getBoundingClientRect().left).toBeGreaterThan(main.getBoundingClientRect().right);
  await page.screenshot({ path: '__screenshots__/side-chat-desktop.png' });
  await page.getByRole('button', { name: 'Close side chat' }).click();
  expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ action: 'close' });
  await expect.element(page.getByRole('textbox', { name: 'Main draft' })).toBeVisible();
});

it('keeps Shift+Enter as a newline and sends a side question with Enter', async () => {
  await openSide();
  await page.getByRole('textbox', { name: 'Side question' }).fill('First line');
  await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
  expect(request).not.toHaveBeenCalled();
  await userEvent.keyboard('Second line{Enter}');
  await expect.element(page.getByText('This is an isolated answer.')).toBeVisible();
  expect(request.mock.calls[0][0]).toMatchObject({
    action: 'ask',
    question: 'First line\nSecond line',
  });
});
