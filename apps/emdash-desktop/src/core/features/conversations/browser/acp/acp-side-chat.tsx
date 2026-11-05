import { Markdown } from '@emdash/ui/react/components';
import {
  Button,
  Popover,
  Resizable,
  ScrollContainer,
  Spinner,
  Textarea,
} from '@emdash/ui/react/primitives';
import { ArrowUp, CornerDownLeft, MessageSquarePlus, Plus, Square, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AcpSideChatModel,
  type SideClient,
  type SideMessage as Message,
} from './acp-side-chat-model';

type SelectionQuote = { text: string; rect: DOMRect };
type Props = {
  client: SideClient | null;
  children: ReactNode;
  onAddToConversation: (text: string) => void;
};

/** 选区只来自主 transcript；输入框和旁支自身不触发浮动菜单。 */
function readQuote(root: HTMLElement | null): SelectionQuote | null {
  const selection = window.getSelection();
  if (!root || !selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const element =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  if (
    !element?.closest('[data-block-id]') ||
    element.closest('input, textarea, [contenteditable="true"]')
  )
    return null;
  const text = selection.toString().trim();
  return text && text.length <= 16_000 ? { text, rect: range.getBoundingClientRect() } : null;
}

type SideLayoutState = {
  host: React.RefObject<HTMLDivElement | null>;
  main: React.RefObject<HTMLDivElement | null>;
  quote: SelectionQuote | null;
  side: { id: string; quote: string } | null;
  narrow: boolean;
  setSide: React.Dispatch<React.SetStateAction<{ id: string; quote: string } | null>>;
  setQuote: React.Dispatch<React.SetStateAction<SelectionQuote | null>>;
  ask: () => void;
};

function useSideLayout(client: SideClient | null): SideLayoutState {
  const host = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const [quote, setQuote] = useState<SelectionQuote | null>(null);
  const [side, setSide] = useState<{ id: string; quote: string } | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    setSide(null);
    setQuote(null);
  }, [client]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setNarrow((entry?.contentRect.width ?? 0) < 720)
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const update = (): void => setQuote(client ? readQuote(main.current) : null);
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [client]);
  const ask = (): void => {
    if (!quote) return;
    setSide((previous) => ({ id: previous?.id ?? crypto.randomUUID(), quote: quote.text }));
    setQuote(null);
    window.getSelection()?.removeAllRanges();
  };
  return { host, main, quote, side, narrow, setSide, setQuote, ask };
}

export function AcpSideChatLayout({ client, children, onAddToConversation }: Props): ReactNode {
  const state = useSideLayout(client);
  return (
    <div ref={state.host} className="h-full min-h-0 min-w-0">
      <Resizable.Group orientation={state.narrow ? 'vertical' : 'horizontal'} className="h-full">
        <Resizable.Panel minSize={state.side && client ? '25%' : '0%'}>
          <div
            ref={state.main}
            className="h-full min-h-0 min-w-0"
            onScrollCapture={() => state.setQuote(null)}
          >
            {children}
          </div>
        </Resizable.Panel>
        {state.side && client && (
          <SidePane
            key={state.side.id}
            narrow={state.narrow}
            client={client}
            sideId={state.side.id}
            quote={state.side.quote}
            onClearQuote={() => state.setSide((value) => (value ? { ...value, quote: '' } : null))}
            onClose={() => state.setSide(null)}
            onAdd={onAddToConversation}
          />
        )}
      </Resizable.Group>
      {state.quote && (
        <SelectionActions
          quote={state.quote}
          onDismiss={() => state.setQuote(null)}
          onAsk={state.ask}
          onAdd={() => {
            const text = state.quote?.text;
            state.setQuote(null);
            window.getSelection()?.removeAllRanges();
            if (text) onAddToConversation(text);
          }}
        />
      )}
    </div>
  );
}

function SelectionActions({
  quote,
  onDismiss,
  onAsk,
  onAdd,
}: {
  quote: SelectionQuote | null;
  onDismiss: () => void;
  onAsk: () => void;
  onAdd: () => void;
}): ReactNode {
  return (
    <Popover.Root
      open={quote !== null}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <Popover.Content
        aria-label="Selected text actions"
        side="top"
        anchor={quote ? { getBoundingClientRect: () => quote.rect } : undefined}
        initialFocus={false}
        finalFocus={false}
        className="gap-1 p-1"
      >
        <div
          className="flex flex-wrap items-center gap-1"
          onMouseDown={(event) => event.preventDefault()}
        >
          <Button variant="ghost" size="sm" onClick={onAdd}>
            <Plus />
            Add to conversation
          </Button>
          <Button variant="ghost" size="sm" onClick={onAsk}>
            <MessageSquarePlus />
            Ask in side chat
          </Button>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

type SideProps = {
  client: SideClient;
  sideId: string;
  quote: string;
  onClearQuote: () => void;
  onClose: () => void;
  onAdd: (text: string) => void;
};
function SidePane({ narrow, ...props }: SideProps & { narrow: boolean }): ReactNode {
  return (
    <>
      <Resizable.Handle />
      <Resizable.Panel
        defaultSize={narrow ? '60%' : '38%'}
        minSize={narrow ? '50%' : '280px'}
        maxSize="70%"
      >
        <SideChat {...props} />
      </Resizable.Panel>
    </>
  );
}

const SideChat = observer(function SideChat({
  client,
  sideId,
  quote,
  onClearQuote,
  onClose,
  onAdd,
}: SideProps): ReactNode {
  const [model] = useState(() => new AcpSideChatModel(client, sideId));
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => model.dispose(), [model]);
  useEffect(() => {
    editor.current?.focus();
  }, [quote]);
  const send = (): void => {
    if (!model.busy && model.draft.trim()) {
      void model.ask(quote);
      onClearQuote();
    }
  };
  return (
    <aside
      aria-label="Side chat"
      className="surface-paper flex h-full min-h-0 min-w-0 flex-col bg-(--em-surface)"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <MessageSquarePlus className="size-4 text-foreground-muted" />
        <span className="flex-1 text-sm font-medium">Side chat</span>
        <Button variant="ghost" size="sm" icon aria-label="Close side chat" onClick={onClose}>
          <X />
        </Button>
      </header>
      <SideTranscript model={model} onAdd={onAdd} />
      <SideComposer
        editor={editor}
        draft={model.draft}
        quote={quote}
        busy={model.busy}
        onDraft={model.setDraft}
        onClearQuote={onClearQuote}
        onSend={send}
        onStop={() => void model.stop()}
      />
    </aside>
  );
});

const SideTranscript = observer(function SideTranscript({
  model,
  onAdd,
}: {
  model: AcpSideChatModel;
  onAdd: (text: string) => void;
}): ReactNode {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [model.messages, model.busy]);
  return (
    <ScrollContainer className="min-h-0 flex-1" viewportClassName="h-full" padding={16}>
      <p className="mb-5 text-xs text-foreground-muted">
        Ask about this conversation. Your main task keeps running.
      </p>
      <div className="space-y-5">
        {model.messages.map((message) => (
          <SideMessage key={message.id} message={message} onAdd={onAdd} />
        ))}
      </div>
      {model.busy && (
        <div role="status" className="mt-4 flex items-center gap-2 text-sm text-foreground-muted">
          <Spinner className="size-3" />
          Thinking…
        </div>
      )}
      {model.error && (
        <p role="alert" className="mt-4 text-sm break-words text-foreground-destructive">
          {model.error}
        </p>
      )}
      <div ref={end} />
    </ScrollContainer>
  );
});

function SideMessage({
  message,
  onAdd,
}: {
  message: Message;
  onAdd: (text: string) => void;
}): ReactNode {
  return (
    <div className="min-w-0 space-y-2">
      {message.quote && (
        <blockquote className="max-h-24 overflow-auto border-l-2 border-border pl-3 text-xs break-words whitespace-pre-wrap text-foreground-muted">
          {message.quote}
        </blockquote>
      )}
      <div
        className={
          message.role === 'user'
            ? 'rounded-lg bg-background-secondary px-3 py-2 text-sm break-words whitespace-pre-wrap'
            : 'min-w-0 overflow-hidden'
        }
      >
        {message.role === 'user' ? (
          message.text
        ) : (
          <Markdown content={message.text} variant="compact" allowHtml={false} />
        )}
      </div>
      {message.role === 'assistant' && (
        <Button variant="ghost" size="xs" onClick={() => onAdd(message.text)}>
          <CornerDownLeft />
          Add to conversation
        </Button>
      )}
    </div>
  );
}

type SideComposerProps = {
  editor: React.RefObject<HTMLTextAreaElement | null>;
  draft: string;
  quote: string;
  busy: boolean;
  onDraft: (text: string) => void;
  onClearQuote: () => void;
  onSend: () => void;
  onStop: () => void;
};

function SideComposer({
  editor,
  draft,
  quote,
  busy,
  onDraft,
  onClearQuote,
  onSend,
  onStop,
}: SideComposerProps): ReactNode {
  return (
    <div className="shrink-0 space-y-2 border-t border-border p-3">
      {quote && <SelectedPassage quote={quote} onClearQuote={onClearQuote} />}
      <Textarea
        ref={editor}
        aria-label="Side question"
        placeholder="Ask a side question…"
        rows={3}
        className="max-h-28 resize-none"
        maxLength={32_000}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!busy) onSend();
          }
        }}
      />
      <SideComposerFooter draft={draft} busy={busy} onSend={onSend} onStop={onStop} />
    </div>
  );
}

function SelectedPassage({
  quote,
  onClearQuote,
}: Pick<SideComposerProps, 'quote' | 'onClearQuote'>): ReactNode {
  return (
    <div className="flex items-start gap-2 rounded-md bg-background-secondary p-2">
      <blockquote className="max-h-20 flex-1 overflow-auto text-xs break-words whitespace-pre-wrap text-foreground-muted">
        {quote}
      </blockquote>
      <Button
        variant="ghost"
        size="xs"
        icon
        aria-label="Remove selected passage"
        onClick={onClearQuote}
      >
        <X />
      </Button>
    </div>
  );
}

function SideComposerFooter({
  draft,
  busy,
  onSend,
  onStop,
}: Pick<SideComposerProps, 'draft' | 'busy' | 'onSend' | 'onStop'>): ReactNode {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-foreground-muted">
        Only added to the main chat if you choose.
      </span>
      {busy ? (
        <Button variant="secondary" size="sm" icon aria-label="Stop side answer" onClick={onStop}>
          <Square />
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          icon
          aria-label="Send side question"
          disabled={!draft.trim()}
          onClick={onSend}
        >
          <ArrowUp />
        </Button>
      )}
    </div>
  );
}
