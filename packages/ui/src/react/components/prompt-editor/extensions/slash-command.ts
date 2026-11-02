/**
 * / 命令与可选的 $ Skill 补全。
 *
 * Reuses the Mention node infrastructure from @tiptap/extension-mention under a
 * different node name (`slashCommand`) and trigger chars (`/` and optionally `$`).
 *
 * Behaviors (determined per-item):
 *  - 'insert'  → inserts a slashCommand atom node serialized with its selected trigger prefix.
 *  - 'insert-text' → inserts the item's raw text directly into the editor.
 *  - 'execute' → calls onCommand(item) and removes the trigger range without
 *                inserting any node.
 */

import type { Editor } from '@tiptap/core';
import { Mention as TipTapMention } from '@tiptap/extension-mention';
import { PluginKey } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { exitSuggestion, type SuggestionOptions } from '@tiptap/suggestion';
import { serializeNode } from '../serialize';
import { SlashCommandPill } from '../slash-command-pill';
import type { CommandItem } from '../types';

const slashCommandPluginKey = new PluginKey('slashCommand');
const skillCommandPluginKey = new PluginKey('skillCommand');

/** 切换 Skill 数据源时关闭旧候选，保留草稿及光标。 */
export function closeCommandSuggestions(editor: Editor): void {
  exitSuggestion(editor.view, slashCommandPluginKey);
  exitSuggestion(editor.view, skillCommandPluginKey);
}

function plainTextInsertContent(text: string) {
  const lines = text.length > 0 ? text.split(/\r?\n/) : [''];
  return lines.map((line) => ({
    type: 'paragraph',
    ...(line.length > 0 ? { content: [{ type: 'text', text: line }] } : {}),
  }));
}

function commandSuggestion(
  prefix: '/' | '$',
  suggestion: Partial<SuggestionOptions<CommandItem>>,
  onExecute: (item: CommandItem) => void
): Partial<SuggestionOptions> {
  return {
    char: prefix,
    allowSpaces: false,
    pluginKey: prefix === '/' ? slashCommandPluginKey : skillCommandPluginKey,
    command({ editor, range, props }) {
      const item = props as unknown as CommandItem;
      const chain = editor.chain().focus().deleteRange(range);
      if (item.behavior === 'execute') {
        chain.run();
        onExecute(item);
      } else if (item.behavior === 'insert-text') {
        chain.insertContentAt(range.from, plainTextInsertContent(item.insertText ?? '')).run();
      } else {
        // 保存实际触发字符，确保展示、复制、退格及发送使用相同语法。
        chain
          .insertContentAt(range.from, [
            {
              type: 'slashCommand',
              attrs: { id: item.id, name: item.name ?? item.id, mentionSuggestionChar: prefix },
            },
            { type: 'text', text: ' ' },
          ])
          .run();
      }
    },
    ...(suggestion as Partial<SuggestionOptions>),
  };
}

export function buildSlashCommandExtension(
  suggestion: Partial<SuggestionOptions<CommandItem>>,
  onExecute: (item: CommandItem) => void,
  skills?: Partial<SuggestionOptions<CommandItem>>
) {
  return TipTapMention.extend({
    name: 'slashCommand',
    addAttributes() {
      return {
        id: { default: null },
        name: { default: null },
        mentionSuggestionChar: { default: '/' },
      };
    },
    addNodeView() {
      return ReactNodeViewRenderer(SlashCommandPill, { as: 'span' });
    },
  }).configure({
    HTMLAttributes: { class: 'slash-command-chip' },
    renderText: ({ node }) => serializeNode(node),
    renderHTML: ({ node }) => [
      'span',
      {
        'data-type': 'slash-command',
        'data-id': node.attrs.id as string,
        'data-name': node.attrs.name as string,
        class: 'slash-command-chip',
      },
      serializeNode(node),
    ],
    suggestions: [
      commandSuggestion('/', suggestion, onExecute),
      ...(skills ? [commandSuggestion('$', skills, onExecute)] : []),
    ],
  });
}
