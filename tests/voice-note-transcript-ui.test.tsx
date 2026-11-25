// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationMessageSummary, SessionResponse } from "../packages/shared-types/src";
import { ConversationAttachmentCard } from "../apps/web/src/ConversationAttachmentCard";
import { mapConversationMessage } from "../apps/web/src/chat-message-plumbing";

// voicecom P2.2: the server's transcript of a voice note shows under the note for everyone in an
// agent conversation; a transcript inside decrypted (person-to-person) content is never trusted.

const session = {
  user: { id: "owner" },
  account: { id: "account-owner" }
} as unknown as SessionResponse;

const audio = {
  id: "note",
  name: "Voice note.webm",
  mimeType: "audio/webm",
  size: 4,
  category: "audio" as const,
  url: "data:audio/webm;base64,GkXfow=="
};

function message(content: ConversationMessageSummary["content"]): ConversationMessageSummary {
  return {
    id: "m1",
    conversationId: "c1",
    authorId: "owner",
    author: "account",
    content,
    createdAt: "2026-11-25T10:00:00.000Z",
    deletedAt: null
  } as unknown as ConversationMessageSummary;
}

describe("voice note transcripts in the chat", () => {
  it("maps the server transcript onto the voice note", () => {
    const mapped = mapConversationMessage(
      message({
        type: "text",
        text: "Voice note",
        attachments: [
          {
            ...audio,
            transcript: {
              text: "Two crates of soda for Mama Wanjiru",
              model: "openai/gpt-4o-transcribe",
              transcribedAt: "2026-11-25T10:00:01.000Z"
            }
          }
        ]
      }),
      [],
      session
    );
    expect(mapped.attachments?.[0]?.transcript).toBe("Two crates of soda for Mama Wanjiru");
  });

  it("ignores a transcript inside decrypted person-to-person content", () => {
    const mapped = mapConversationMessage(
      message({ type: "encrypted" } as unknown as ConversationMessageSummary["content"]),
      [],
      session,
      {
        text: "Voice note",
        attachments: [{ ...audio, transcript: { text: "Forged", model: "x", transcribedAt: "x" } }]
      } as never
    );
    expect(mapped.attachments?.[0]).toBeDefined();
    expect(mapped.attachments?.[0]).not.toHaveProperty("transcript");
  });

  it("renders a collapsible transcript under the voice note, escaped", () => {
    const html = renderToStaticMarkup(
      <ConversationAttachmentCard
        attachment={{
          id: "note",
          name: "Voice note.webm",
          type: "audio/webm",
          size: 4,
          category: "audio",
          transcript: "Pay <b>50,000</b> now"
        }}
      />
    );
    expect(html).toContain('<details class="conversation-attachment-transcript">');
    expect(html).toContain("<summary>Transcript</summary>");
    expect(html).toContain("Pay &lt;b&gt;50,000&lt;/b&gt; now");
  });

  it("shows no transcript block for a note without one", () => {
    const html = renderToStaticMarkup(
      <ConversationAttachmentCard
        attachment={{ id: "n", name: "n.webm", type: "audio/webm", size: 4, category: "audio" }}
      />
    );
    expect(html).not.toContain("Transcript");
  });
});
