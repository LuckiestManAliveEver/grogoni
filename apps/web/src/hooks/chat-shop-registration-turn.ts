import type { Dispatch, SetStateAction } from "react";

import { deviceOnlyAnchor, saveDeviceOnlyMessages } from "../chat-device-only-messages";
import type { ChatMessage } from "../app-shell";
import { createClientMessageId, getErrorMessage } from "../chat-message-plumbing";
import {
  continueShopRegistration,
  readPendingShopRegistration,
  savePendingShopRegistration,
  startShopRegistration,
  type ShopRegistrationStep
} from "../shop-registration-chat";

type ShopChatScope = { accountId: string; threadId: string | null };

/** A flow belongs to one account and one thread: a reply elsewhere is not an answer to it. */
export function pendingShopStep(scope: ShopChatScope): ShopRegistrationStep | null {
  const pending = readPendingShopRegistration();
  return pending?.accountId === scope.accountId && pending.threadId === scope.threadId
    ? pending.step
    : null;
}

export function rememberShopStep(scope: ShopChatScope, step: ShopRegistrationStep | null): void {
  savePendingShopRegistration(step === null ? null : { ...scope, step });
}

/** Starts the flow from a reply the guest assistant chose, and returns that reply. */
export function beginShopRegistration(scope: ShopChatScope): string {
  const turn = startShopRegistration();
  rememberShopStep(scope, turn.next);
  return turn.reply;
}

/**
 * Answers one message of the flow on the device, without the model, so a shop is only created from
 * what the person typed.
 */
export async function runShopRegistrationTurn(input: {
  scope: ShopChatScope;
  step: ShopRegistrationStep | null;
  message: string;
  savedPhone: string | null;
  thread: string | null;
  chatMessages: ChatMessage[];
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  afterBubble: () => void;
  register: (shop: { name: string; phoneNumber: string | null }) => Promise<string>;
  setStatusMessage: (message: string) => void;
}): Promise<void> {
  const { scope, step, message } = input;
  const deviceOnlyAfter = deviceOnlyAnchor(input.chatMessages);
  const place = (author: "merchant" | "grogoniclaw", body: string) => {
    const placed: ChatMessage = {
      id: createClientMessageId(author === "merchant" ? "buyer" : "agent"),
      author,
      body,
      createdAt: new Date().toISOString(),
      deviceOnlyIn: input.thread,
      deviceOnlyAfter
    };
    saveDeviceOnlyMessages(scope.accountId, [placed]);
    input.setChatMessages((messages) => [...messages, placed]);
  };
  place("merchant", message);
  input.afterBubble();
  const turn =
    step === null
      ? startShopRegistration()
      : continueShopRegistration(step, message, input.savedPhone);
  if (turn.kind !== "register") {
    rememberShopStep(scope, turn.kind === "ask" ? turn.next : null);
    place("grogoniclaw", turn.reply);
    return;
  }
  rememberShopStep(scope, null);
  try {
    input.setStatusMessage(await input.register(turn));
  } catch (error) {
    if (turn.phoneNumber !== null) rememberShopStep(scope, { step: "phone", name: turn.name });
    place(
      "grogoniclaw",
      `I could not register the shop. ${getErrorMessage(error)}${
        turn.phoneNumber === null ? "" : " Send the phone number again, or say cancel."
      }`
    );
  }
}
