import { ImageViewerDialog } from '@emdash/ui/react/components';
import { Button, Spinner } from '@emdash/ui/react/primitives';
import { MessageSquarePlus, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ChatTranscript,
  type ChatView,
} from '@core/features/conversations/api/browser/chat/chat-transcript';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { log } from '@core/primitives/logging/browser/logger';
import { resolveAttachmentDataUrl } from './acp-attachment-data-url';
import { AcpChatStore } from './acp-chat-store';
import { AcpSideChatLayout } from './acp-side-chat';
import { createTranscriptFileCommands } from './transcript-file-commands';

type Props = {
  parent: AcpChatStore;
  sideId: string;
  quote: string;
  onClose: () => void;
  onAdd: (text: string) => void;
  renderComposer: (
    store: AcpChatStore,
    slot: HTMLElement,
    onViewerOpen: (src?: string, alt?: string) => void
  ) => ReactNode;
};

/** 旁支只负责临时会话生命周期，输入和执行能力完全复用主会话。 */
function useSideStore(
  parent: AcpChatStore,
  sideId: string
): { store: AcpChatStore | null; error: string | null } {
  const [store, setStore] = useState<AcpChatStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let side: AcpChatStore | undefined;
    void getConversationsClient()
      .then(async (client) => {
        const opened = await client.acp.openSideSession({
          conversationId: parent.conversationId,
          sideId,
        });
        if (disposed) {
          const result = await client.acp.closeSideSession(opened);
          if (!result.success) throw new Error('Failed to close the unused side chat');
          return;
        }
        side = new AcpChatStore(
          opened.conversationId,
          parent.projectId,
          parent.taskId,
          parent.hostAccess,
          {
            parentConversationId: parent.conversationId,
            providerId: 'codex',
          }
        );
        setStore(side);
        side.bootstrap();
      })
      .catch((cause: unknown) => {
        log.error('Failed to open side chat', { error: cause });
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
      side?.dispose();
    };
  }, [parent, sideId]);
  return { store, error };
}

export const AcpSideSessionPane = observer(function AcpSideSessionPane(props: Props): ReactNode {
  const { store, error } = useSideStore(props.parent, props.sideId);
  return (
    <aside
      aria-label="Side chat"
      className="surface-paper flex h-full min-h-0 min-w-0 flex-col bg-(--em-surface)"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <MessageSquarePlus className="size-4 text-foreground-muted" />
        <span className="flex-1 text-sm font-medium">Side chat</span>
        <Button variant="ghost" size="sm" icon aria-label="Close side chat" onClick={props.onClose}>
          <X />
        </Button>
      </header>
      {error && (
        <p role="alert" className="p-3 text-sm text-foreground-destructive">
          {error}
        </p>
      )}
      {!store && !error && (
        <div role="status" className="p-3">
          <Spinner />
        </div>
      )}
      {store && <SideSessionContent {...props} store={store} />}
    </aside>
  );
});

const SideSessionContent = observer(function SideSessionContent({
  store,
  quote,
  onAdd,
  renderComposer,
}: Props & { store: AcpChatStore }): ReactNode {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [viewer, setViewer] = useState<{ src?: string; alt?: string } | null>(null);
  const ready = useCallback(
    (view: ChatView) => {
      store.bindView(view);
      setSlot(view.composerSlot);
    },
    [store]
  );
  useEffect(() => {
    store.addDraftQuote(quote);
  }, [quote, store]);
  const files = createTranscriptFileCommands({ projectId: store.projectId, taskId: store.taskId });
  return (
    <div className="min-h-0 flex-1">
      <AcpSideChatLayout enabled onAddToConversation={onAdd}>
        <ChatTranscript
          context={store.chatContext}
          state={store.chatState}
          composer="slot"
          composerPlacement="bottom"
          stickToBottom
          pinUserMessages
          onReady={ready}
          commands={{
            classifyLink: files.classifyLink,
            onOpenFile: files.onOpenFile,
            onStop: () => store.stop(),
            onClickMention: ({ id, kind }) => {
              if (kind === 'file') files.openMentionFile(id);
            },
            resolveAttachment: (attachment) => resolveAttachmentDataUrl(store, attachment.id),
            onViewImage: ({ attachment }) => {
              if (attachment.dataUrl) setViewer({ src: attachment.dataUrl, alt: attachment.name });
              else
                void resolveAttachmentDataUrl(store, attachment.id).then((src) =>
                  setViewer({ src: src ?? undefined, alt: attachment.name })
                );
            },
          }}
        />
      </AcpSideChatLayout>
      {slot && renderComposer(store, slot, (src, alt) => setViewer({ src, alt }))}
      <ImageViewerDialog
        open={viewer !== null}
        onOpenChange={(open) => {
          if (!open) setViewer(null);
        }}
        src={viewer?.src}
        alt={viewer?.alt}
      />
    </div>
  );
});
