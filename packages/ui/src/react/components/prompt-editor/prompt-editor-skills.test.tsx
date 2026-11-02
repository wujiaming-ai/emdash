/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PromptEditor } from './prompt-editor';
import { PromptEditorModel } from './prompt-editor-model';
import type { CommandItem } from './types';

afterEach(cleanup);

it('preserves skill text through copy, detachment and draft restore', async () => {
  const model = new PromptEditorModel();
  const view = render(<PromptEditor model={model} />);
  const editor = model.getSnapshot().editor!;
  act(() =>
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'slashCommand',
              attrs: { id: '$review', name: 'review', mentionSuggestionChar: '$' },
            },
            { type: 'text', text: ' src/main.ts' },
          ],
        },
      ],
    })
  );
  expect(model.getText()).toBe('$review src/main.ts');
  expect(editor.getText()).toBe('$review src/main.ts');
  expect(editor.getHTML()).toContain('$review');
  const clipboard = editor.view.someProp('clipboardTextSerializer');
  expect(clipboard?.(editor.state.doc.slice(0), editor.view)).toBe('$review src/main.ts');
  view.unmount();
  const onSubmit = vi.fn();
  const restored = render(<PromptEditor model={model} onSubmit={onSubmit} />);
  expect(model.getText()).toBe('$review src/main.ts');
  act(() => fireEvent.keyDown(restored.getByTestId('prompt-editor'), { key: 'Enter' }));
  expect(onSubmit).toHaveBeenCalledWith('$review src/main.ts');
  restored.unmount();
  model.dispose();
  const fromDisk = new PromptEditorModel({ text: '$review src/main.ts' });
  render(<PromptEditor model={fromDisk} />);
  expect(fromDisk.getText()).toBe('$review src/main.ts');
  cleanup();
  fromDisk.dispose();
});

it('discards skills resolved after switching away from the provider', async () => {
  let resolve!: (items: CommandItem[]) => void;
  const querySkills = vi.fn(
    () =>
      new Promise<CommandItem[]>((done) => {
        resolve = done;
      })
  );
  const model = new PromptEditorModel();
  const view = render(<PromptEditor model={model} querySkills={querySkills} />);
  const editor = model.getSnapshot().editor!;
  act(() => {
    editor.view.focus();
    editor.commands.insertContent('$rev');
  });
  await waitFor(() => expect(querySkills).toHaveBeenCalledWith('rev'));
  view.rerender(<PromptEditor model={model} />);
  await act(async () =>
    resolve([{ id: '$review', name: 'review', prefix: '$', behavior: 'insert' }])
  );
  expect(view.queryByRole('option')).toBeNull();
  expect(model.getText()).toBe('$rev');
  view.unmount();
  model.dispose();
});

it('closes an already visible skill menu when the provider stops supporting skills', async () => {
  const model = new PromptEditorModel();
  const querySkills = async (): Promise<CommandItem[]> => [
    { id: '$review', name: 'review', prefix: '$', behavior: 'insert' },
  ];
  const view = render(<PromptEditor model={model} querySkills={querySkills} />);
  const editor = model.getSnapshot().editor!;
  act(() => {
    editor.view.focus();
    editor.commands.insertContent('$rev');
  });
  await waitFor(() => expect(view.queryByRole('option')).not.toBeNull());
  view.rerender(<PromptEditor model={model} />);
  await waitFor(() => expect(view.queryByRole('option')).toBeNull());
  expect(model.getText()).toBe('$rev');
  view.unmount();
  model.dispose();
});
