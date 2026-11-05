import { encodeResourceUri } from '@emdash/core/primitives/path/api';
import {
  dedupeDescendantPaths,
  type FileTreeContextMenuItem,
  type FileTreeNode,
} from '@emdash/ui/react/components';
import { Download } from 'lucide-react';
import { openModal } from '@core/manifests/browser/modal-api';
import { hostFileRefFromNativePath } from '@core/primitives/desktop-runtime/api';

export function downloadMenuItem(
  connectionId: string | undefined,
  node: FileTreeNode,
  selection: readonly FileTreeNode[],
  disabled: boolean
): FileTreeContextMenuItem[] {
  if (!connectionId) return [];
  return [
    {
      id: 'download',
      label: 'Download…',
      icon: <Download size={14} />,
      disabled,
      onSelect: () => {
        const paths = dedupeDescendantPaths(
          (selection.length ? selection : [node]).map((item) => item.path)
        );
        void openModal('downloadFilesModal', {
          sources: paths.map((path) =>
            encodeResourceUri(hostFileRefFromNativePath(path, connectionId))
          ),
        });
      },
    },
  ];
}
