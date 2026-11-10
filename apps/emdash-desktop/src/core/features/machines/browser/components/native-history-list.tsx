import { formatHostRef } from '@emdash/core/primitives/host/api';
import type { NativeSession } from '@emdash/core/runtimes/acp/api/client';
import { EmptyState } from '@emdash/ui/react/components';
import {
  CollectionToolbar,
  CollectionView,
  CollectionViewCell,
  createListView,
  createTextMatcher,
  useQueryListSource,
  type CollectionViewColumn,
  type ListSource,
} from '@emdash/ui/react/patterns';
import { Button, Spinner, toast } from '@emdash/ui/react/primitives';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { useNavigate } from '@core/primitives/navigation/browser/navigation-hooks';
import { openNativeHistoryLocation } from '../open-native-history';
import type { MachineConversationsScope } from '../use-machine-conversations';

/** 分页结果按原生 ID 去重；刷新或翻页不让选中行因重复记录而跳动。 */
export function uniqueNativeSessions(
  pages: readonly { sessions: NativeSession[] }[]
): NativeSession[] {
  const sessions = new Map<string, NativeSession>();
  for (const page of pages) for (const item of page.sessions) sessions.set(item.sessionId, item);
  return [...sessions.values()];
}

function createHistoryView(source: ListSource<NativeSession>) {
  return createListView({
    getItemId: (item: NativeSession) => item.sessionId,
    source,
    search: {
      kind: 'sync',
      predicate: createTextMatcher((item: NativeSession) => [item.title, item.cwd]),
    },
  });
}

type HistoryProps = {
  scope: MachineConversationsScope;
  providerId: 'codex' | 'claude';
  hostReachable: boolean;
};

function useHistoryQuery({ scope, providerId, hostReachable }: HistoryProps) {
  const host = formatHostRef(
    hostRefFromConnectionId(scope.kind === 'remote' ? scope.connectionId : undefined)
  );
  const client = useQueryClient();
  const queryKey = ['nativeHistory', host, providerId];
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (await getConversationsClient()).nativeHistory.list({ host, providerId, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: hostReachable,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  return { host, query, refresh: () => void client.resetQueries({ queryKey, exact: true }) };
}

function useHistoryOpen(host: ReturnType<typeof formatHostRef>, hostReachable: boolean) {
  const { navigate } = useNavigate();
  const [busyId, setBusyId] = useState<string | null>(null);
  const open = async (item: NativeSession): Promise<void> => {
    if (busyId || !hostReachable) return;
    setBusyId(item.sessionId);
    try {
      const location = await (
        await getConversationsClient()
      ).nativeHistory.open({ host, selectionId: item.selectionId });
      await openNativeHistoryLocation(location, navigate);
    } catch (error) {
      toast.error('Could not open CLI history', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyId(null);
    }
  };
  return { busyId, open };
}

function historyColumns(
  busyId: string | null,
  enabled: boolean,
  open: (item: NativeSession) => Promise<void>
): CollectionViewColumn<NativeSession>[] {
  return [
    {
      id: 'title',
      width: 'minmax(0, 1fr)',
      cell: (item) => <CollectionViewCell primary={item.title} secondary={item.cwd} />,
    },
    {
      id: 'open',
      width: 'max-content',
      cell: (item) => (
        <Button
          size="xs"
          variant="ghost"
          disabled={busyId !== null || !enabled}
          onClick={() => void open(item)}
        >
          {busyId === item.sessionId ? <Spinner size="sm" /> : 'Open'}
        </Button>
      ),
    },
  ];
}

export function NativeHistoryList(props: HistoryProps) {
  const { host, query, refresh } = useHistoryQuery(props);
  const { busyId, open } = useHistoryOpen(host, props.hostReachable);
  const items = uniqueNativeSessions(query.data?.pages ?? []);
  const source = useQueryListSource(
    {
      data: items,
      isLoading: props.hostReachable && query.isLoading,
      isError: query.isError && !query.data,
      error: query.error,
    },
    (rows) => rows
  );
  const [view] = useState(() => createHistoryView(source));
  return (
    <view.Root>
      <CollectionView
        view={view}
        columns={historyColumns(busyId, props.hostReachable, open)}
        toolbar={
          <HistoryToolbar
            view={view}
            refresh={refresh}
            disabled={query.isFetching || !props.hostReachable}
          />
        }
        emptySlot={
          <EmptyState
            bare
            label={
              props.hostReachable
                ? 'No CLI history found.'
                : 'Reconnect this machine to browse CLI history.'
            }
          />
        }
        errorSlot={
          <EmptyState bare label="Could not load CLI history." description={query.error?.message} />
        }
      />
      <HistoryPagination query={query} enabled={props.hostReachable} />
    </view.Root>
  );
}

function HistoryPagination({
  query,
  enabled,
}: {
  query: ReturnType<typeof useHistoryQuery>['query'];
  enabled: boolean;
}) {
  return (
    <>
      {query.isFetchNextPageError && (
        <p className="text-destructive mt-2 text-xs" role="alert">
          {query.error?.message}
        </p>
      )}
      {query.hasNextPage && (
        <Button
          className="mt-2"
          variant="ghost"
          disabled={query.isFetching || !enabled}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? (
            <>
              <Spinner size="sm" /> Loading…
            </>
          ) : query.isFetchNextPageError ? (
            'Retry loading more'
          ) : (
            'Show more'
          )}
        </Button>
      )}
    </>
  );
}

const HistoryToolbar = observer(function HistoryToolbar({
  view,
  refresh,
  disabled,
}: {
  view: ReturnType<typeof createHistoryView>;
  refresh: () => void;
  disabled: boolean;
}) {
  const search = view.useSearch();
  return (
    <CollectionToolbar.Root>
      <CollectionToolbar.Search
        value={search.query}
        onValueChange={search.setQuery}
        placeholder="Search loaded history…"
      />
      <CollectionToolbar.Spacer />
      <Button variant="ghost" onClick={refresh} disabled={disabled}>
        Refresh
      </Button>
    </CollectionToolbar.Root>
  );
});
