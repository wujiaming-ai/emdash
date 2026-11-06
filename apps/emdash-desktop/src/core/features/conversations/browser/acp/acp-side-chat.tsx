import { Button, Popover, Resizable } from '@emdash/ui/react/primitives';
import { MessageSquarePlus, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

type SelectionQuote = { text: string; rect: DOMRect };
type Props = {
  enabled: boolean;
  renderSide?: (props: { sideId: string; quote: string; onClose: () => void }) => ReactNode;
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

function useSideLayout(enabled: boolean): SideLayoutState {
  const host = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const [quote, setQuote] = useState<SelectionQuote | null>(null);
  const [side, setSide] = useState<{ id: string; quote: string } | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    setSide(null);
    setQuote(null);
  }, [enabled]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setNarrow((entry?.contentRect.width ?? 0) < 720)
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const update = (): void => setQuote(enabled ? readQuote(main.current) : null);
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [enabled]);
  const ask = (): void => {
    if (!quote) return;
    setSide((previous) => ({ id: previous?.id ?? crypto.randomUUID(), quote: quote.text }));
    setQuote(null);
    window.getSelection()?.removeAllRanges();
  };
  return { host, main, quote, side, narrow, setSide, setQuote, ask };
}

export function AcpSideChatLayout({
  enabled,
  children,
  renderSide,
  onAddToConversation,
}: Props): ReactNode {
  const state = useSideLayout(enabled);
  return (
    <div ref={state.host} className="h-full min-h-0 min-w-0">
      <Resizable.Group orientation={state.narrow ? 'vertical' : 'horizontal'} className="h-full">
        <Resizable.Panel minSize={state.side && enabled && renderSide ? '25%' : '0%'}>
          <div
            ref={state.main}
            className="h-full min-h-0 min-w-0"
            onScrollCapture={() => state.setQuote(null)}
          >
            {children}
          </div>
        </Resizable.Panel>
        {state.side && enabled && renderSide && (
          <>
            <Resizable.Handle />
            <Resizable.Panel
              defaultSize={state.narrow ? '60%' : '38%'}
              minSize={state.narrow ? '50%' : '280px'}
              maxSize="70%"
            >
              {renderSide({
                sideId: state.side.id,
                quote: state.side.quote,
                onClose: () => state.setSide(null),
              })}
            </Resizable.Panel>
          </>
        )}
      </Resizable.Group>
      {state.quote && (
        <SelectionActions
          quote={state.quote}
          onDismiss={() => state.setQuote(null)}
          onAsk={renderSide ? state.ask : undefined}
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

/** 松开拖选或双击后的 click 属于选区操作，不能被当作弹框外部点击。 */
function isSelectionCompletion(event: Event, quote: SelectionQuote | null): boolean {
  const selection = window.getSelection();
  return Boolean(
    event.type === 'click' &&
    event.target instanceof Element &&
    event.target.closest('[data-block-id]') &&
    selection?.rangeCount &&
    !selection.isCollapsed &&
    selection.toString().trim() === quote?.text &&
    selection.getRangeAt(0).intersectsNode(event.target)
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
  onAsk?: () => void;
  onAdd: () => void;
}): ReactNode {
  return (
    <Popover.Root
      open={quote !== null}
      onOpenChange={(open, details) => {
        if (details.reason === 'outside-press' && isSelectionCompletion(details.event, quote)) {
          details.cancel();
          return;
        }
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
          {onAsk && (
            <Button variant="ghost" size="sm" onClick={onAsk}>
              <MessageSquarePlus />
              Ask in side chat
            </Button>
          )}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
