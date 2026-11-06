import { Button, Popover, Textarea } from '@emdash/ui/react/primitives';
import { MessageSquareQuote, Pencil, Trash2, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState, type ReactNode } from 'react';
import {
  ACP_DRAFT_MAX_LENGTH,
  type AcpDraftQuote,
} from '@core/features/conversations/contributions/mementos';
import type { AcpChatStore } from './acp-chat-store';

/** 引用独立于正文，沿用 Emdash 的按钮、弹层和输入控件。 */
export const AcpDraftReferences = observer(function AcpDraftReferences({
  store,
}: {
  store: AcpChatStore;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const count = store.draftQuotes.length;
  if (!count) return null;
  return (
    <div className="px-3 pt-3">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <ReferenceTrigger
          count={count}
          onClear={() => {
            store.removeDraftQuote();
            setOpen(false);
          }}
        />
        <Popover.Content
          side="top"
          align="start"
          className="w-96 max-w-[calc(100vw-2rem)]"
          // 显式移除弹层默认内边距，避免与引用行的留白叠加。
          style={{ padding: 0, gap: 0 }}
          aria-label="Selected text references"
        >
          <div className="max-h-72 divide-y divide-border overflow-y-auto">
            {store.draftQuotes.map((quote, index) => (
              <ReferenceRow key={quote.id} quote={quote} index={index} store={store} />
            ))}
          </div>
        </Popover.Content>
      </Popover.Root>
    </div>
  );
});

function ReferenceTrigger({ count, onClear }: { count: number; onClear: () => void }): ReactNode {
  return (
    <div className="inline-flex max-w-full items-center rounded-md border border-border">
      <Popover.Trigger render={<Button variant="ghost" size="sm" />}>
        <MessageSquareQuote />
        {count} {count === 1 ? 'reference' : 'references'}
      </Popover.Trigger>
      <Button variant="ghost" size="sm" icon aria-label="Remove all references" onClick={onClear}>
        <X />
      </Button>
    </div>
  );
}

function ReferenceRow({
  quote,
  index,
  store,
}: {
  quote: AcpDraftQuote;
  index: number;
  store: AcpChatStore;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex items-start gap-2 p-2">
      <span className="pt-1 text-sm text-foreground-muted">{index + 1}.</span>
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 text-sm text-foreground-muted">Selected text</p>
        {editing ? (
          <ReferenceEditor
            quote={quote}
            onCancel={() => setEditing(false)}
            onSave={(text) => {
              store.updateDraftQuote(quote.id, text);
              setEditing(false);
            }}
          />
        ) : (
          <p className="text-sm break-words whitespace-pre-wrap">{quote.text}</p>
        )}
      </div>
      <ReferenceActions
        editing={editing}
        index={index}
        onEdit={() => setEditing(true)}
        onRemove={() => store.removeDraftQuote(quote.id)}
      />
    </div>
  );
}

function ReferenceActions({
  editing,
  index,
  onEdit,
  onRemove,
}: {
  editing: boolean;
  index: number;
  onEdit: () => void;
  onRemove: () => void;
}): ReactNode {
  return (
    <>
      {!editing && (
        <Button
          variant="ghost"
          size="sm"
          icon
          aria-label={`Edit reference ${index + 1}`}
          onClick={onEdit}
        >
          <Pencil />
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        icon
        aria-label={`Remove reference ${index + 1}`}
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
    </>
  );
}

function ReferenceEditor({
  quote,
  onSave,
  onCancel,
}: {
  quote: AcpDraftQuote;
  onSave: (text: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [text, setText] = useState(quote.text);
  return (
    <div className="space-y-2">
      <Textarea
        aria-label="Reference text"
        autoFocus
        rows={3}
        maxLength={ACP_DRAFT_MAX_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="secondary" size="sm" disabled={!text.trim()} onClick={() => onSave(text)}>
          Save
        </Button>
      </div>
    </div>
  );
}
