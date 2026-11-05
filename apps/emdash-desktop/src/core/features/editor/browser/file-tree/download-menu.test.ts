import { decodeResourceUri } from '@emdash/core/primitives/path/api';
import type { FileTreeNode } from '@emdash/ui/react/components';
import { expect, it, vi } from 'vitest';
import { downloadMenuItem } from './download-menu';
const open = vi.hoisted(() => vi.fn());
vi.mock('@core/manifests/browser/modal-api', () => ({ openModal: open }));
const node = { path: '/repo/file' } as FileTreeNode;
it('adds the action only to remote files and respects disabled state', () => {
  expect(downloadMenuItem(undefined, node, [], false)).toEqual([]);
  expect(downloadMenuItem('ssh-2', node, [], true)[0]).toMatchObject({
    id: 'download',
    disabled: true,
  });
});
it('passes selected remote paths and removes nested duplicates', () => {
  const selection = [
    { path: '/repo/folder' },
    { path: '/repo/folder/child' },
    node,
  ] as FileTreeNode[];
  const item = downloadMenuItem('ssh-2', node, selection, false)[0];
  if (!('onSelect' in item)) throw new Error('Missing action');
  item.onSelect?.(node, selection);
  expect(open).toHaveBeenCalledWith('downloadFilesModal', { sources: expect.any(Array) });
  const uris = open.mock.calls.at(-1)?.[1].sources as string[];
  expect(uris).toHaveLength(2);
  for (const uri of uris)
    expect(decodeResourceUri(uri)).toMatchObject({
      success: true,
      data: { host: { type: 'remote', id: 'ssh-2' } },
    });
});
