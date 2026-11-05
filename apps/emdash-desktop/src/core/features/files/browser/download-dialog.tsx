import {
  absoluteBasename,
  decodeResourceUri,
  formatAbsolute,
  type ResourceUri,
} from '@emdash/core/primitives/path/api';
import { SteppedLoaderProgress } from '@emdash/ui/react/components';
import { Button, Collapsible, Dialog, Field, Select } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactElement } from 'react';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import { downloadConflictSchema, type DownloadProgress } from '../api/downloads';
import { DownloadStore } from './download-store';

export const DownloadDialog = observer(function DownloadDialog({
  sources,
}: {
  sources: ResourceUri[];
}): ReactElement {
  const modal = useModalController('downloadFilesModal');
  const [store] = useState(() => new DownloadStore(sources));
  useCloseGuard(store.busy);
  useEffect(() => () => store.pause(), [store]);
  return (
    <>
      <Dialog.Header showCloseButton={!store.busy}>
        <Dialog.Title>Download files</Dialog.Title>
        <Dialog.Description className="break-all">{sourceLabel(sources)}</Dialog.Description>
      </Dialog.Header>
      <DownloadBody store={store} />
      <DownloadFooter store={store} close={modal.dismiss} />
    </>
  );
});

function sourceLabel(sources: ResourceUri[]): string {
  if (sources.length !== 1) return `${sources.length} selected items`;
  const source = decodeResourceUri(sources[0]!);
  return source.success
    ? absoluteBasename(source.data.path) || formatAbsolute(source.data.path)
    : sources[0]!;
}

const DownloadBody = observer(function DownloadBody({
  store,
}: {
  store: DownloadStore;
}): ReactElement {
  return (
    <Dialog.Body>
      <Field.Group>
        {!store.session && <ConflictOptions store={store} />}
        {store.status !== 'ready' && (
          <DownloadStatus status={store.status} progress={store.progress} error={store.error} />
        )}
        {store.session && (
          <Field.Root>
            <span className="text-xs text-foreground-muted">
              {store.status === 'complete' ? 'Saved to' : 'Save to'}
            </span>
            <p className="break-all">{store.session.destination}</p>
          </Field.Root>
        )}
        {store.status !== 'complete' && <DownloadHelp />}
      </Field.Group>
    </Dialog.Body>
  );
});

const conflictLabels = {
  'keep-both': 'Keep both',
  skip: 'Skip existing files',
  replace: 'Replace existing files',
};
const ConflictOptions = observer(function ConflictOptions({
  store,
}: {
  store: DownloadStore;
}): ReactElement {
  return (
    <Field.Root>
      <Field.Label>If a file already exists</Field.Label>
      <Select.Root
        value={store.conflict}
        disabled={store.busy}
        onValueChange={(value) => {
          if (value !== null) store.setConflict(downloadConflictSchema.parse(value));
        }}
      >
        <Select.Trigger appearance="input" className="w-full" aria-label="If a file already exists">
          {conflictLabels[store.conflict]}
        </Select.Trigger>
        <Select.Content>
          {Object.entries(conflictLabels).map(([value, label]) => (
            <Select.Item key={value} value={value}>
              {label}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      {store.conflict === 'replace' && (
        <Field.Description>
          Existing files are replaced only after each download finishes.
        </Field.Description>
      )}
    </Field.Root>
  );
});

function DownloadHelp(): ReactElement {
  return (
    <Collapsible.Root>
      <Collapsible.Trigger>About downloads</Collapsible.Trigger>
      <Collapsible.Panel className="pt-2">
        <p className="text-xs leading-relaxed text-foreground-muted">
          Pause and resume anytime. After reopening Emdash, select the same items, destination and
          conflict option to continue. Discarding partial files keeps completed downloads. Symbolic
          links and special files are skipped.
        </p>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

const DownloadFooter = observer(function DownloadFooter({
  store,
  close,
}: {
  store: DownloadStore;
  close: () => void;
}): ReactElement {
  return (
    <Dialog.Footer className="flex-wrap">
      {store.busy ? (
        <Button variant="secondary" disabled={!store.session} onClick={store.pause}>
          Pause
        </Button>
      ) : (
        <Button variant="secondary" onClick={close}>
          {store.status === 'complete' ? 'Done' : 'Close'}
        </Button>
      )}
      {store.session && !store.busy && store.status !== 'complete' && (
        <Button
          variant="secondary"
          onClick={() =>
            void store.discard().then((done) => {
              if (done) close();
            })
          }
        >
          Discard partial download
        </Button>
      )}
      {!store.busy && store.status !== 'complete' && (
        <Button variant="primary" onClick={() => void store.start()}>
          {store.session ? 'Resume' : 'Choose destination…'}
        </Button>
      )}
    </Dialog.Footer>
  );
});

const statusLabels: Record<string, string> = {
  complete: 'Download complete',
  paused: 'Download paused',
  failed: 'Download failed',
  running: 'Downloading…',
  ready: 'Ready to download',
};
export function DownloadStatus({
  status,
  progress,
  error,
}: {
  status: string;
  progress?: DownloadProgress;
  error: string;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-2" role="status" aria-live="polite">
      <p className="font-medium">{statusLabels[status]}</p>
      {progress && <TransferSummary progress={progress} complete={status === 'complete'} />}
      {error && (
        <p role="alert" className="text-destructive text-sm break-all">
          {error}
        </p>
      )}
    </div>
  );
}

function TransferSummary({
  progress,
  complete,
}: {
  progress: DownloadProgress;
  complete: boolean;
}): ReactElement {
  return (
    <>
      {!complete && (
        <>
          <p className="text-xs break-all text-foreground-muted">{progress.path}</p>
          <SteppedLoaderProgress
            aria-label="Current file download progress"
            percent={progress.size ? (progress.bytes / progress.size) * 100 : 0}
            leftLabel={`${formatBytes(progress.bytes)} / ${formatBytes(progress.size)}`}
            rightLabel={`${Math.round(progress.size ? (progress.bytes / progress.size) * 100 : 0)}%`}
          />
        </>
      )}
      <p className="text-xs text-foreground-muted">
        {progress.files} {progress.files === 1 ? 'file' : 'files'} ·{' '}
        {formatBytes(progress.transferred)} downloaded
        {progress.skipped > 0 && ` · ${progress.skipped} skipped`}
      </p>
      {progress.warnings.length > 0 && (
        <Collapsible.Root>
          <Collapsible.Trigger>Skipped items</Collapsible.Trigger>
          <Collapsible.Panel className="pt-2">
            {progress.warnings.map((warning) => (
              <p className="text-xs break-all text-foreground-muted" key={warning}>
                {warning}
              </p>
            ))}
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
    </>
  );
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export const downloadFilesModal = defineModal<void>()({
  id: 'downloadFilesModal',
  component: DownloadDialog,
  size: 'sm',
});
