import { useEffect, useRef, useState } from "react";

import type { ConversationMessageSummary } from "@grogoni/shared-types";

import { postJson, putJson } from "../../api-helpers";
import { getErrorMessage, logClientEvent } from "../../chat-message-plumbing";
import { ApiRequestError } from "../../lib/api";
import {
  regenerationRefusalMessage,
  sharedReplyVersionRequests,
  type ReplyVersionControls
} from "./reply-version-requests";

/** What the hook needs from the chat state that owns the open thread (useChatInboxState). */
export interface ReplyVersionDeps {
  /** The signed-in account: retry keys are kept per account. Null when signed out. */
  accountId: string | null;
  /** The open conversation, or null. */
  conversationId: string | null;
  /** The viewer's own business when its agent answers in this conversation; otherwise null. */
  businessId: string | null;
  setStatusMessage: (message: string) => void;
  /** Replaces one message of the open thread with the server's copy of it. */
  applyServerMessage: (conversationId: string, message: ConversationMessageSummary) => void;
}

/**
 * Regenerating an agent reply and moving between its versions
 * (docs/architecture/conversation-reply-versions.md). One regenerate at a time. The server decides
 * what is allowed and refuses any version that would change business records; this hook only asks,
 * shows the answer, and says why when it is refused.
 */
export function useReplyVersions(deps: ReplyVersionDeps): ReplyVersionControls {
  const { accountId, conversationId, businessId, setStatusMessage, applyServerMessage } = deps;
  const [regeneratingMessageId, setRegeneratingMessageId] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const contextEpoch = useRef(0);
  useEffect(() => {
    setRegeneratingMessageId(null);
    return () => {
      contextEpoch.current += 1;
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [accountId, conversationId, businessId]);

  async function regenerate(messageId: string) {
    if (accountId === null || conversationId === null || businessId === null) return;
    if (inFlight.current !== null) return;
    const requests = sharedReplyVersionRequests(accountId);
    const epoch = contextEpoch.current;
    const controller = new AbortController();
    inFlight.current = controller;
    setRegeneratingMessageId(messageId);
    const startedAt = Date.now();
    try {
      const updated = await postJson<ConversationMessageSummary>(
        `/v1/conversations/${conversationId}/messages/${messageId}/regenerate`,
        { businessId, versionId: requests.idFor(messageId) },
        { signal: controller.signal, timeoutMs: 120_000 }
      );
      if (contextEpoch.current !== epoch) return;
      requests.settle(messageId);
      applyServerMessage(conversationId, updated);
      logClientEvent("chat.reply_regenerated", {
        conversationId,
        messageId,
        versionCount: updated.replyVersions?.versions.length ?? 1,
        latencyMs: Date.now() - startedAt
      });
    } catch (error) {
      if (contextEpoch.current !== epoch) return;
      // Only a refusal the server will repeat releases the id. After a stop, a timeout, a dropped
      // connection, a 5xx, or "still running" (409 from the turn lock) the version may have been
      // written where the server could not cancel: asking again with the same id then answers
      // with that version instead of writing a second one.
      const code = error instanceof ApiRequestError ? error.code : null;
      if (regenerationRefusalMessage(code) !== null) requests.settle(messageId);
      logClientEvent("chat.reply_regeneration_failed", { conversationId, messageId, code });
      setStatusMessage(
        controller.signal.aborted
          ? "Stopped waiting for the new version."
          : (regenerationRefusalMessage(code) ?? getErrorMessage(error))
      );
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setRegeneratingMessageId(null);
      }
    }
  }

  async function select(messageId: string, index: number) {
    if (accountId === null || conversationId === null || inFlight.current !== null) return;
    const epoch = contextEpoch.current;
    try {
      const updated = await putJson<ConversationMessageSummary>(
        `/v1/conversations/${conversationId}/messages/${messageId}/reply-version`,
        { index }
      );
      if (contextEpoch.current === epoch) applyServerMessage(conversationId, updated);
    } catch (error) {
      if (contextEpoch.current !== epoch) return;
      setStatusMessage(getErrorMessage(error));
    }
  }

  return {
    available: accountId !== null && conversationId !== null && businessId !== null,
    regeneratingMessageId,
    onRegenerate: (messageId) => void regenerate(messageId),
    // Closes the request. The Node API cancels the turn and writes nothing; where the server
    // cannot cancel (the Edge API), the kept retry key makes the next Regenerate answer with the
    // version that was written.
    onCancel: () => inFlight.current?.abort(),
    onSelect: (messageId, index) => void select(messageId, index)
  };
}
