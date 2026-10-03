import { useState } from "react";

import { createInitialChatMessages, type ChatAttachment, type ChatMessage } from "../app-shell";

interface UseChatThreadStateDeps {
  initialNavigationSession: {
    chatDraft?: string;
    runtimeSessionId?: string | null;
    chatMessages?: ChatMessage[];
    activeConversationId?: string | null;
  } | null;
  initialBusiness: { name: string } | null;
  registerReset: (domainKey: string, fn: () => void) => void;
}

export function useChatThreadState(deps: UseChatThreadStateDeps) {
  const [chatDraft, setChatDraft] = useState(deps.initialNavigationSession?.chatDraft ?? "");
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [runtimeSessionId, setRuntimeSessionId] = useState<string | null>(
    deps.initialNavigationSession?.runtimeSessionId ?? null
  );
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() =>
    deps.initialNavigationSession !== null &&
    (deps.initialNavigationSession.chatMessages?.length ?? 0) > 0
      ? (deps.initialNavigationSession.chatMessages as ChatMessage[])
      : createInitialChatMessages(deps.initialBusiness?.name ?? "Grogoni")
  );
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);

  deps.registerReset("chat-thread", () => {
    setChatDraft("");
    setPendingAttachments([]);
    setRuntimeSessionId(null);
    setChatMessages(createInitialChatMessages("Grogoni"));
    setReplyToMessageId(null);
  });

  return {
    chatDraft,
    setChatDraft,
    pendingAttachments,
    setPendingAttachments,
    runtimeSessionId,
    setRuntimeSessionId,
    chatMessages,
    setChatMessages,
    replyToMessageId,
    setReplyToMessageId
  };
}
