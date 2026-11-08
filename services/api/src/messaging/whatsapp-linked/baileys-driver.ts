import type {
  WAMessageKey,
  AuthenticationCreds,
  SignalDataTypeMap,
  SignalDataSet,
  LIDMapping
} from "baileys";
import { createHash } from "node:crypto";
import type { LinkedDriver, LinkedMutation } from "./connector.js";
import { linkedMediaMaxBytes, LinkedMediaRejected, type LinkedMedia } from "./media.js";

/** Lazy import keeps native protocol dependencies out of disabled/serverless routes. */
export function createBaileysLinkedDriver(
  diagnostic?: (event: { type: string; count?: number; addressing?: string }) => void
): LinkedDriver {
  return {
    async open(input) {
      const {
        default: makeWASocket,
        initAuthCreds,
        BufferJSON,
        proto,
        DisconnectReason,
        jidNormalizedUser,
        normalizeMessageContent,
        downloadContentFromMessage
      } = await import("baileys");
      const stored = input.auth
        ? (JSON.parse(input.auth, BufferJSON.reviver) as {
            creds: AuthenticationCreds;
            keys: Record<string, unknown>;
          })
        : null;
      const creds = stored?.creds ?? initAuthCreds();
      const keys: Record<string, unknown> = stored?.keys ?? {};
      let closed = false;
      let mappingKey: string | undefined;
      let approvedMappings: Promise<LIDMapping[] | null> | undefined;
      let pendingIdentities = 0;
      const save = () => {
        if (!closed && creds.registered)
          input.save(JSON.stringify({ creds, keys }, BufferJSON.replacer));
      };
      // Protocol logs may include credentials, message contents and pairing codes. Never forward them.
      const noop = () => undefined;
      const logger = {
        level: "silent",
        child: () => logger,
        trace: noop,
        debug: noop,
        info: noop,
        warn: noop,
        error: noop
      };
      let readyResolve: () => void = noop;
      const pairingReady = new Promise<void>((resolve) => {
        readyResolve = resolve;
      });
      const socket = makeWASocket({
        logger,
        auth: {
          creds,
          keys: {
            get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
              const result: Record<string, SignalDataTypeMap[T]> = {};
              for (const id of ids) {
                let value = keys[`${type}:${id}`];
                if (type === "app-state-sync-key" && value)
                  value = proto.Message.AppStateSyncKeyData.fromObject(
                    value as Record<string, unknown>
                  );
                if (value) result[id] = value as SignalDataTypeMap[T];
              }
              return result;
            },
            set: async (data: SignalDataSet) => {
              for (const [type, values] of Object.entries(data))
                for (const [id, value] of Object.entries(values ?? {})) {
                  const key = `${type}:${id}`;
                  if (value === null) delete keys[key];
                  else keys[key] = value;
                }
              save();
            }
          }
        },
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        shouldIgnoreJid: (jid) =>
          jid === "status@broadcast" || jid.endsWith("@newsletter") || jid.endsWith("@broadcast"),
        getMessage: async () => undefined,
        connectTimeoutMs: 20_000,
        defaultQueryTimeoutMs: 20_000
      });
      socket.ev.on("creds.update", (update) => {
        Object.assign(creds, update);
        save();
      });
      socket.ev.on("connection.update", (update) => {
        if (closed) return;
        if (update.qr) readyResolve();
        if (update.connection === "open") {
          if (input.expectedPhone)
            diagnostic?.({
              type: [socket.user?.id, socket.user?.phoneNumber].some(
                (jid) => jid && jidNormalizedUser(jid) === `${input.expectedPhone}@s.whatsapp.net`
              )
                ? "account_matches_requested"
                : "account_does_not_match_requested"
            });
          if (
            input.expectedPhone &&
            ![socket.user?.id, socket.user?.phoneNumber].some(
              (jid) => jid && jidNormalizedUser(jid) === `${input.expectedPhone}@s.whatsapp.net`
            )
          ) {
            input.state("close", "auth");
            socket.end(undefined);
            return;
          }
          if (!socket.user?.id) {
            input.state("close", "auth");
            return;
          }
          save();
          input.state("open");
        }
        if (update.connection === "close") {
          const code = (
            update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
          )?.output?.statusCode;
          input.state(
            "close",
            code === DisconnectReason.loggedOut
              ? "revoked"
              : code === DisconnectReason.badSession ||
                  code === DisconnectReason.connectionReplaced ||
                  code === DisconnectReason.multideviceMismatch
                ? "auth"
                : code === DisconnectReason.restartRequired
                  ? "restart"
                  : "retry"
          );
        }
      });
      // Mutation events use the same encrypted write-ahead inbox as fresh messages.
      const mutation = async (
        key: WAMessageKey,
        change: LinkedMutation,
        text = "[Message update]",
        timestamp = Math.floor(Date.now() / 1000)
      ) => {
        if (
          closed ||
          !key.id ||
          key.id.length > 200 ||
          !key.remoteJid ||
          text.length > 4000 ||
          !text.trim() ||
          !Number.isFinite(timestamp) ||
          timestamp < 0 ||
          timestamp > 8.64e12 ||
          pendingIdentities >= 64
        )
          return;
        pendingIdentities++;
        try {
          const alias = async (jid: string, alternate?: string | null) => {
            if (!jid.endsWith("@lid")) return jidNormalizedUser(jid);
            if (alternate && /^[1-9][0-9]{6,14}@s\.whatsapp\.net$/.test(alternate))
              return alternate;
            return (
              (await socket.signalRepository?.lidMapping?.getPNForLID(jid)) ??
              jidNormalizedUser(jid)
            );
          };
          const chat = await alias(key.remoteJid, key.remoteJidAlt);
          const sender = key.participant ? await alias(key.participant, key.participantAlt) : chat;
          if (closed) return;
          const id =
            "mutation:" +
            createHash("sha256")
              .update(
                JSON.stringify([key.id, change, text, change.kind === "receipt" ? null : timestamp])
              )
              .digest("hex");
          input.inbound({
            id,
            chat,
            sender,
            text,
            timestamp: new Date(timestamp * 1000).toISOString(),
            fromMe: Boolean(key.fromMe),
            mentioned: false,
            mutation: change
          });
        } catch {
          if (!closed) input.state("close", "retry");
        } finally {
          pendingIdentities--;
        }
      };
      socket.ev.on("messages.update", (updates) => {
        for (const { key, update } of updates) {
          if (!key.id) continue;
          const edited = normalizeMessageContent(update.message?.editedMessage?.message);
          const text =
            edited?.conversation ??
            edited?.extendedTextMessage?.text ??
            edited?.imageMessage?.caption ??
            edited?.documentMessage?.caption;
          if (text)
            void mutation(
              key,
              { kind: "edit", targetId: key.id, fromMe: Boolean(key.fromMe) },
              text,
              Number(update.messageTimestamp ?? Math.floor(Date.now() / 1000))
            );
          else if (
            update.message === null &&
            update.messageStubType === proto.WebMessageInfo.StubType.REVOKE
          )
            void mutation(key, { kind: "delete", targetId: key.id, fromMe: Boolean(key.fromMe) });
          else if (key.fromMe && update.status != null) {
            const status =
              update.status === 0
                ? "failed"
                : update.status >= 4
                  ? "read"
                  : update.status === 3
                    ? "delivered"
                    : update.status === 2
                      ? "sent"
                      : null;
            if (status)
              void mutation(key, { kind: "receipt", targetId: key.id, fromMe: true, status });
          }
        }
      });
      socket.ev.on("messages.delete", (update) => {
        // Bulk history deletion is not permission to erase an imported shop inbox.
        if ("keys" in update)
          for (const key of update.keys)
            if (key.id)
              void mutation(key, { kind: "delete", targetId: key.id, fromMe: Boolean(key.fromMe) });
      });
      socket.ev.on("messages.upsert", ({ type, messages }) => {
        if (closed) return;
        diagnostic?.({ type: `upsert_${type}`, count: messages.length });
        if (type !== "notify") return;
        for (const message of messages) {
          if (
            !message.key.id ||
            message.key.id.length > 200 ||
            !message.key.remoteJid ||
            message.key.fromMe ||
            (message.key.participant?.length ?? 0) > 200
          ) {
            diagnostic?.({ type: message.key.fromMe ? "ignored_self" : "ignored_identity" });
            continue;
          }
          const content = normalizeMessageContent(message.message);
          // Media isn't downloaded or sent to inference without a bounded attachment pipeline.
          const mediaContent =
            content?.imageMessage ?? content?.documentMessage ?? content?.audioMessage;
          const mediaType = content?.imageMessage
            ? "image"
            : content?.documentMessage
              ? "document"
              : "audio";
          let media: LinkedMedia | undefined;
          if (mediaContent) {
            const size = Number(mediaContent.fileLength);
            const mimeType = (mediaContent.mimetype ?? "").split(";")[0]!.trim().toLowerCase();
            const allowed = [
              "image/jpeg",
              "image/png",
              "image/webp",
              "application/pdf",
              "text/plain",
              "text/csv",
              "audio/ogg",
              "audio/opus",
              "audio/mpeg",
              "audio/mp4",
              "audio/x-m4a",
              "audio/wav",
              "audio/x-wav"
            ];
            if (
              size > 0 &&
              size <= linkedMediaMaxBytes &&
              allowed.includes(mimeType) &&
              mediaContent.directPath?.startsWith("/") &&
              !mediaContent.directPath.startsWith("//") &&
              mediaContent.directPath.length <= 4096 &&
              mediaContent.mediaKey?.length === 32 &&
              mediaContent.fileSha256?.length === 32
            )
              media = {
                type: mediaType,
                mimeType,
                size,
                directPath: mediaContent.directPath,
                filename: (content?.documentMessage?.fileName ?? mediaType).slice(0, 120),
                key: Buffer.from(mediaContent.mediaKey).toString("base64"),
                sha256: Buffer.from(mediaContent.fileSha256).toString("base64")
              };
          }
          const suppliedText =
            content?.conversation ??
            content?.extendedTextMessage?.text ??
            content?.imageMessage?.caption ??
            content?.documentMessage?.caption;
          const text = suppliedText?.trim()
            ? suppliedText
            : mediaContent
              ? media
                ? mediaType === "audio"
                  ? "[Voice note received. Speech transcription is unavailable; listen to the attached audio.]"
                  : `[${mediaType === "image" ? "Image" : "Document"} attachment received.]`
                : "[Attachment rejected: unsupported format or size.]"
              : undefined;
          if (!text) {
            diagnostic?.({ type: "ignored_non_text" });
            continue;
          }
          const context = content?.extendedTextMessage?.contextInfo ?? mediaContent?.contextInfo;
          const own = new Set(
            [socket.user?.id, socket.user?.lid, socket.user?.phoneNumber]
              .filter((jid): jid is string => Boolean(jid))
              .map(jidNormalizedUser)
          );
          // WhatsApp may address contacts by LID. Only the protocol's paired PN alias can
          // satisfy a phone-number scope; display names and usernames never establish identity.
          const phoneAlias = (jid: string, alternate?: string | null): string =>
            jid.endsWith("@lid") &&
            alternate &&
            /^[1-9][0-9]{6,14}@s\.whatsapp\.net$/.test(alternate)
              ? alternate
              : jidNormalizedUser(jid);
          const chat = phoneAlias(message.key.remoteJid, message.key.remoteJidAlt);
          const sender = message.key.participant
            ? phoneAlias(message.key.participant, message.key.participantAlt)
            : chat;
          const timestamp = Number(message.messageTimestamp);
          const messageId = message.key.id;
          if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > 8.64e12) continue;
          const deliver = (resolvedChat = chat) => {
            if (closed) return;
            diagnostic?.({
              type: "notify_text",
              addressing: resolvedChat.split("@")[1] ?? "unknown"
            });
            input.inbound({
              id: messageId,
              chat: resolvedChat,
              sender: sender === chat ? resolvedChat : sender,
              text,
              timestamp: new Date(timestamp * 1000).toISOString(),
              fromMe: false,
              mentioned: (context?.mentionedJid ?? []).some((jid) =>
                own.has(jidNormalizedUser(jid))
              ),
              ...(media ? { media: [media] } : {}),
              ...(context?.stanzaId ? { replyTo: context.stanzaId } : {})
            });
          };
          if (chat.endsWith("@lid") && socket.signalRepository?.lidMapping) {
            if (pendingIdentities >= 64) {
              input.state("close", "retry");
              return;
            }
            pendingIdentities++;
            const resolve = async () => {
              const mapping = socket.signalRepository.lidMapping;
              const known = await mapping.getPNForLID(chat);
              if (known) return known;
              const approved = [...new Set(input.approvedContacts?.() ?? [])]
                .filter((jid) => /^[1-9][0-9]{6,14}@s\.whatsapp\.net$/.test(jid))
                .sort()
                .slice(0, 100);
              if (!approved.length) return null;
              const key = JSON.stringify(approved);
              if (mappingKey !== key) {
                mappingKey = key;
                // One bounded protocol query per approved scope set and socket. Unknown
                // senders cannot expand the lookup to contacts the owner did not approve.
                approvedMappings = (async () => {
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  try {
                    return await Promise.race([
                      mapping.getLIDsForPNs(approved),
                      new Promise<null>((resolve) => {
                        timer = setTimeout(() => resolve(null), 20_000);
                      })
                    ]);
                  } catch {
                    return null;
                  } finally {
                    clearTimeout(timer);
                  }
                })();
              }
              const found = (await approvedMappings)?.find(
                (entry) => jidNormalizedUser(entry.lid) === chat && approved.includes(entry.pn)
              );
              diagnostic?.({
                type: found ? "approved_identity_resolved" : "approved_identity_unresolved"
              });
              return found?.pn ?? null;
            };
            void resolve()
              .then(
                (pn) => deliver(phoneAlias(chat, pn)),
                () => deliver()
              )
              .catch(() => {
                if (!closed) input.state("close", "retry");
              })
              .finally(() => {
                pendingIdentities--;
              });
          } else deliver();
        }
      });
      return {
        async downloadMedia(media, signal) {
          if (
            closed ||
            media.size < 1 ||
            media.size > linkedMediaMaxBytes ||
            !media.directPath.startsWith("/") ||
            media.directPath.startsWith("//") ||
            media.directPath.length > 4096 ||
            Buffer.from(media.key, "base64").length !== 32
          )
            throw new LinkedMediaRejected("Invalid media descriptor.");
          const stream = await downloadContentFromMessage(
            { mediaKey: Buffer.from(media.key, "base64"), directPath: media.directPath },
            media.type,
            {
              host: "mmg.whatsapp.net",
              options: {
                signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
                redirect: "error"
              }
            }
          );
          const chunks: Buffer[] = [];
          let size = 0;
          try {
            for await (const chunk of stream) {
              const bytes = Buffer.from(chunk as Uint8Array);
              size += bytes.length;
              if (size > linkedMediaMaxBytes || size > media.size)
                throw new LinkedMediaRejected("Media exceeds its declared size.");
              chunks.push(bytes);
            }
            return Buffer.concat(chunks);
          } finally {
            stream.destroy();
          }
        },
        async pairingCode(phone) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              pairingReady,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Pairing timed out.")), 20_000);
              })
            ]);
            if (closed) throw new Error("Pairing ended.");
            return await socket.requestPairingCode(phone);
          } finally {
            clearTimeout(timer);
          }
        },
        async groups() {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              socket.groupFetchAllParticipating(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Group lookup timed out.")), 15_000);
              })
            ]);
            if (closed) throw new Error("Connection changed.");
            return Object.values(result)
              .slice(0, 100)
              .map((group) => ({ chat: group.id, name: group.subject.slice(0, 120) }));
          } finally {
            clearTimeout(timer);
          }
        },
        async send(chat, text, messageId, media, quote) {
          // Audio is sent as a document so its caption remains in the single provider message.
          const content = !media
            ? { text }
            : media.category === "image"
              ? { image: media.bytes, mimetype: media.mimeType, caption: text }
              : {
                  document: media.bytes,
                  mimetype: media.mimeType,
                  fileName: media.filename,
                  caption: text
                };
          const result = await socket.sendMessage(chat, content, {
            messageId,
            ...(quote
              ? {
                  quoted: {
                    key: {
                      id: quote.id,
                      remoteJid: chat,
                      fromMe: quote.fromMe,
                      ...(chat.endsWith("@g.us") && quote.sender
                        ? { participant: quote.sender }
                        : {})
                    },
                    message: { conversation: quote.text }
                  }
                }
              : {})
          });
          if (!result?.key.id) throw new Error("WhatsApp did not acknowledge delivery.");
          return result.key.id;
        },
        close() {
          closed = true;
          socket.end(undefined);
        },
        async logout() {
          await socket.logout();
        }
      };
    }
  };
}
export const baileysLinkedDriver = createBaileysLinkedDriver();
