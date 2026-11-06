import { log } from '@core/primitives/logging/browser/logger';
import type { AcpChatStore } from './acp-chat-store';

const attachmentDataUrlCache = new Map<string, string>();

export async function resolveAttachmentDataUrl(
  store: AcpChatStore,
  id: string
): Promise<string | null> {
  const cacheKey = `${store.conversationId}:${id}`;
  const cached = attachmentDataUrlCache.get(cacheKey);
  if (cached) return cached;
  try {
    const result = await store.downloadAttachment(id);
    if (!result.success) return null;
    const dataUrl = `data:${result.data.ref.mimeType};base64,${bytesToBase64(result.data.data)}`;
    attachmentDataUrlCache.set(cacheKey, dataUrl);
    return dataUrl;
  } catch (error) {
    log.warn('Failed to resolve ACP attachment', { id, error });
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
