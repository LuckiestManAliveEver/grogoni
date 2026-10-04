import { createHash, randomBytes } from "node:crypto";
import type {
  ConnectedMailboxProvider,
  ConnectedMailboxProviderSummary
} from "@grogoni/shared-types";

export interface EmailProviderTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string;
  tokenType: string;
}

export interface EmailProviderProfile {
  providerAccountId: string;
  address: string;
}

export interface EmailProviderAuthorization {
  profile: EmailProviderProfile;
  tokens: EmailProviderTokens;
}

export interface EmailProviderSendRequest {
  provider: ConnectedMailboxProvider;
  accessToken: string;
  senderAddress: string;
  recipientAddress: string;
  subject: string;
  text: string;
  idempotencyKey: string;
  externalThreadId: string | null;
  replyToProviderMessageId: string | null;
  attachments: EmailProviderAttachment[];
}

export interface EmailProviderAttachment {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

export interface EmailProviderSendResult {
  externalMessageId: string | null;
  externalThreadId: string | null;
}

export interface NormalizedProviderEmail {
  externalMessageId: string;
  externalThreadId: string;
  senderAddress: string;
  recipientAddresses: string[];
  ccAddresses: string[];
  subject: string;
  text: string;
  receivedAt: string;
  automated: boolean;
}

export interface EmailMailboxProviderClient {
  providers(): ConnectedMailboxProviderSummary[];
  beginAuthorization(input: { provider: ConnectedMailboxProvider; redirectUri: string }): {
    authorizationUrl: string;
    state: string;
    codeVerifier: string;
  };
  completeAuthorization(input: {
    provider: ConnectedMailboxProvider;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<EmailProviderAuthorization>;
  refreshAuthorization(input: {
    provider: ConnectedMailboxProvider;
    refreshToken: string;
  }): Promise<EmailProviderTokens>;
  send(input: EmailProviderSendRequest): Promise<EmailProviderSendResult>;
  fetchInbound(input: {
    provider: ConnectedMailboxProvider;
    accessToken: string;
    since: string;
    limit?: number;
  }): Promise<NormalizedProviderEmail[]>;
  revoke(input: { provider: ConnectedMailboxProvider; accessToken: string | null }): Promise<void>;
}

export type EmailProviderErrorCode =
  | "EMAIL_PROVIDER_UNAVAILABLE"
  | "EMAIL_REAUTHORIZATION_REQUIRED"
  | "EMAIL_SEND_FAILED"
  | "EMAIL_SYNC_FAILED";

export class EmailProviderClientError extends Error {
  constructor(
    readonly code: EmailProviderErrorCode,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "EmailProviderClientError";
  }
}

interface ProviderConfiguration {
  provider: ConnectedMailboxProvider;
  displayName: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export function createEmailMailboxProviderClient(
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch
): EmailMailboxProviderClient {
  return new EnvironmentEmailMailboxProviderClient(environment, fetcher);
}

class EnvironmentEmailMailboxProviderClient implements EmailMailboxProviderClient {
  private readonly configurations: Record<ConnectedMailboxProvider, ProviderConfiguration>;

  constructor(
    environment: NodeJS.ProcessEnv,
    private readonly fetcher: typeof fetch
  ) {
    this.configurations = {
      gmail: {
        provider: "gmail",
        displayName: "Gmail",
        clientId: firstEnvironmentValue(environment, [
          "MAILBOX_GOOGLE_CLIENT_ID",
          "OAUTH_GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_ID"
        ]),
        clientSecret: firstEnvironmentValue(environment, [
          "MAILBOX_GOOGLE_CLIENT_SECRET",
          "OAUTH_GOOGLE_CLIENT_SECRET",
          "GOOGLE_CLIENT_SECRET"
        ]),
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: [
          "openid",
          "email",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/gmail.readonly"
        ]
      },
      outlook: {
        provider: "outlook",
        displayName: "Outlook",
        clientId: firstEnvironmentValue(environment, [
          "MAILBOX_MICROSOFT_CLIENT_ID",
          "OAUTH_MICROSOFT_CLIENT_ID",
          "MICROSOFT_CLIENT_ID"
        ]),
        clientSecret: firstEnvironmentValue(environment, [
          "MAILBOX_MICROSOFT_CLIENT_SECRET",
          "OAUTH_MICROSOFT_CLIENT_SECRET",
          "MICROSOFT_CLIENT_SECRET"
        ]),
        authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        scopes: ["openid", "email", "profile", "offline_access", "Mail.Send", "Mail.Read"]
      }
    };
  }

  providers(): ConnectedMailboxProviderSummary[] {
    return Object.values(this.configurations).map((configuration) => ({
      provider: configuration.provider,
      displayName: configuration.displayName,
      configured: isConfigured(configuration),
      canSend: true,
      canReceive: true
    }));
  }

  beginAuthorization(input: { provider: ConnectedMailboxProvider; redirectUri: string }): {
    authorizationUrl: string;
    state: string;
    codeVerifier: string;
  } {
    const configuration = this.requireConfiguration(input.provider);
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(64).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const url = new URL(configuration.authorizationUrl);
    url.searchParams.set("client_id", configuration.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", configuration.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (input.provider === "gmail") {
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("include_granted_scopes", "true");
      url.searchParams.set("prompt", "consent");
    } else {
      url.searchParams.set("response_mode", "query");
    }
    return { authorizationUrl: url.toString(), state, codeVerifier };
  }

  async completeAuthorization(input: {
    provider: ConnectedMailboxProvider;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<EmailProviderAuthorization> {
    const configuration = this.requireConfiguration(input.provider);
    const tokens = await this.exchangeTokens(configuration, {
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code"
    });
    const profile = await this.fetchProfile(input.provider, tokens.accessToken);
    return { profile, tokens };
  }

  async refreshAuthorization(input: {
    provider: ConnectedMailboxProvider;
    refreshToken: string;
  }): Promise<EmailProviderTokens> {
    const configuration = this.requireConfiguration(input.provider);
    const refreshed = await this.exchangeTokens(configuration, {
      refresh_token: input.refreshToken,
      grant_type: "refresh_token"
    });
    return { ...refreshed, refreshToken: refreshed.refreshToken ?? input.refreshToken };
  }

  async send(input: EmailProviderSendRequest): Promise<EmailProviderSendResult> {
    return input.provider === "gmail" ? this.sendGmail(input) : this.sendOutlook(input);
  }

  async fetchInbound(input: {
    provider: ConnectedMailboxProvider;
    accessToken: string;
    since: string;
    limit?: number;
  }): Promise<NormalizedProviderEmail[]> {
    const limit = normalizeFetchLimit(input.limit);
    return input.provider === "gmail"
      ? this.fetchGmailInbound(input.accessToken, input.since, limit)
      : this.fetchOutlookInbound(input.accessToken, input.since, limit);
  }

  async revoke(input: {
    provider: ConnectedMailboxProvider;
    accessToken: string | null;
  }): Promise<void> {
    if (input.provider !== "gmail" || input.accessToken === null) return;
    await this.fetcher(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(input.accessToken)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" }
      }
    ).catch(() => undefined);
  }

  private requireConfiguration(provider: ConnectedMailboxProvider): ProviderConfiguration {
    const configuration = this.configurations[provider];
    if (!isConfigured(configuration)) {
      throw new EmailProviderClientError(
        "EMAIL_PROVIDER_UNAVAILABLE",
        `${configuration.displayName} mailbox authorization is not configured.`
      );
    }
    return configuration;
  }

  private async exchangeTokens(
    configuration: ProviderConfiguration,
    parameters: Record<string, string>
  ): Promise<EmailProviderTokens> {
    const response = await this.fetcher(configuration.tokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        ...parameters
      })
    });
    if (!response.ok) {
      throw new EmailProviderClientError(
        "EMAIL_REAUTHORIZATION_REQUIRED",
        "Mailbox authorization could not be refreshed. Reconnect the mailbox."
      );
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const accessToken = requiredProviderString(payload.access_token, "access token");
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : null;
    return {
      accessToken,
      refreshToken: optionalProviderString(payload.refresh_token),
      expiresAt:
        expiresIn === null
          ? null
          : new Date(Date.now() + Math.max(0, expiresIn - 60) * 1000).toISOString(),
      scope: optionalProviderString(payload.scope) ?? configuration.scopes.join(" "),
      tokenType: optionalProviderString(payload.token_type) ?? "Bearer"
    };
  }

  private async fetchProfile(
    provider: ConnectedMailboxProvider,
    accessToken: string
  ): Promise<EmailProviderProfile> {
    const url =
      provider === "gmail"
        ? "https://gmail.googleapis.com/gmail/v1/users/me/profile"
        : "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName";
    const response = await this.providerFetch(url, accessToken, "EMAIL_REAUTHORIZATION_REQUIRED");
    const payload = (await response.json()) as Record<string, unknown>;
    const address = requiredProviderString(
      provider === "gmail" ? payload.emailAddress : (payload.mail ?? payload.userPrincipalName),
      "mailbox address"
    );
    return {
      providerAccountId:
        provider === "gmail"
          ? address
          : requiredProviderString(payload.id, "provider account identifier"),
      address
    };
  }

  private async sendGmail(input: EmailProviderSendRequest): Promise<EmailProviderSendResult> {
    const raw = createRfc822Message(input);
    const response = await this.providerFetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      input.accessToken,
      "EMAIL_SEND_FAILED",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          raw: Buffer.from(raw).toString("base64url"),
          ...(input.externalThreadId === null ? {} : { threadId: input.externalThreadId })
        })
      }
    );
    const payload = (await response.json()) as Record<string, unknown>;
    return {
      externalMessageId: requiredProviderString(payload.id, "message identifier"),
      externalThreadId: requiredProviderString(payload.threadId, "thread identifier")
    };
  }

  private async sendOutlook(input: EmailProviderSendRequest): Promise<EmailProviderSendResult> {
    const reply = input.replyToProviderMessageId !== null;
    if (reply) {
      if (input.attachments.length === 0) {
        await this.providerFetch(
          `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(input.replyToProviderMessageId as string)}/reply`,
          input.accessToken,
          "EMAIL_SEND_FAILED",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ comment: input.text })
          }
        );
        return {
          externalMessageId: input.replyToProviderMessageId,
          externalThreadId: input.externalThreadId
        };
      }
      const replyDraftResponse = await this.providerFetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(input.replyToProviderMessageId as string)}/createReply`,
        input.accessToken,
        "EMAIL_SEND_FAILED",
        { method: "POST" }
      );
      const replyDraft = (await replyDraftResponse.json()) as Record<string, unknown>;
      const replyDraftId = requiredProviderString(replyDraft.id, "reply draft identifier");
      await this.updateOutlookDraft(replyDraftId, input);
      await this.sendOutlookDraft(replyDraftId, input.accessToken);
      return {
        externalMessageId: replyDraftId,
        externalThreadId: input.externalThreadId
      };
    }

    const draftResponse = await this.providerFetch(
      "https://graph.microsoft.com/v1.0/me/messages",
      input.accessToken,
      "EMAIL_SEND_FAILED",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: input.subject,
          body: { contentType: "Text", content: input.text },
          toRecipients: [{ emailAddress: { address: input.recipientAddress } }],
          internetMessageHeaders: [{ name: "x-grogoni-message-id", value: input.idempotencyKey }],
          attachments: outlookAttachments(input.attachments)
        })
      }
    );
    const draft = (await draftResponse.json()) as Record<string, unknown>;
    const messageId = requiredProviderString(draft.id, "message identifier");
    const threadId = requiredProviderString(draft.conversationId, "thread identifier");
    await this.sendOutlookDraft(messageId, input.accessToken);
    return { externalMessageId: messageId, externalThreadId: threadId };
  }

  private async updateOutlookDraft(
    draftId: string,
    input: EmailProviderSendRequest
  ): Promise<void> {
    await this.providerFetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draftId)}`,
      input.accessToken,
      "EMAIL_SEND_FAILED",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: { contentType: "Text", content: input.text } })
      }
    );
    for (const attachment of outlookAttachments(input.attachments)) {
      await this.providerFetch(
        `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draftId)}/attachments`,
        input.accessToken,
        "EMAIL_SEND_FAILED",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(attachment)
        }
      );
    }
  }

  private async sendOutlookDraft(draftId: string, accessToken: string): Promise<void> {
    await this.providerFetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draftId)}/send`,
      accessToken,
      "EMAIL_SEND_FAILED",
      { method: "POST" }
    );
  }

  private async fetchGmailInbound(
    accessToken: string,
    since: string,
    limit: number
  ): Promise<NormalizedProviderEmail[]> {
    const after = Math.floor(Date.parse(since) / 1000);
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(limit));
    listUrl.searchParams.set("q", `in:inbox -in:spam -in:trash after:${after}`);
    const listResponse = await this.providerFetch(
      listUrl.toString(),
      accessToken,
      "EMAIL_SYNC_FAILED"
    );
    const list = (await listResponse.json()) as { messages?: Array<{ id?: string }> };
    const messages: NormalizedProviderEmail[] = [];
    for (const item of list.messages ?? []) {
      if (typeof item.id !== "string") continue;
      const response = await this.providerFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`,
        accessToken,
        "EMAIL_SYNC_FAILED"
      );
      messages.push(normalizeGmailMessage((await response.json()) as GmailMessage));
    }
    return messages;
  }

  private async fetchOutlookInbound(
    accessToken: string,
    since: string,
    limit: number
  ): Promise<NormalizedProviderEmail[]> {
    const url = new URL("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages");
    url.searchParams.set("$top", String(limit));
    url.searchParams.set("$orderby", "receivedDateTime asc");
    url.searchParams.set("$filter", `receivedDateTime ge ${new Date(since).toISOString()}`);
    url.searchParams.set(
      "$select",
      "id,conversationId,subject,from,toRecipients,ccRecipients,body,bodyPreview,receivedDateTime,internetMessageHeaders"
    );
    const response = await this.providerFetch(url.toString(), accessToken, "EMAIL_SYNC_FAILED");
    const payload = (await response.json()) as { value?: OutlookMessage[] };
    return (payload.value ?? []).map(normalizeOutlookMessage);
  }

  private async providerFetch(
    url: string,
    accessToken: string,
    failureCode: EmailProviderErrorCode,
    init: RequestInit = {}
  ): Promise<Response> {
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...(init.headers ?? {})
      }
    });
    if (response.status === 401 || response.status === 403) {
      throw new EmailProviderClientError(
        "EMAIL_REAUTHORIZATION_REQUIRED",
        "Mailbox authorization was revoked or no longer grants the required permissions."
      );
    }
    if (!response.ok) {
      throw new EmailProviderClientError(failureCode, "The mailbox provider request failed.", true);
    }
    return response;
  }
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
  headers?: Array<{ name?: string; value?: string }>;
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

interface OutlookRecipient {
  emailAddress?: { address?: string };
}

interface OutlookMessage {
  id?: string;
  conversationId?: string;
  subject?: string;
  from?: OutlookRecipient;
  toRecipients?: OutlookRecipient[];
  ccRecipients?: OutlookRecipient[];
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  receivedDateTime?: string;
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
}

function normalizeGmailMessage(message: GmailMessage): NormalizedProviderEmail {
  const headers = new Map(
    (message.payload?.headers ?? []).map((header) => [
      header.name?.toLowerCase() ?? "",
      header.value ?? ""
    ])
  );
  const sender = extractEmailAddress(headers.get("from") ?? "");
  const text = extractGmailBody(message.payload) || "(No text content)";
  return {
    externalMessageId: requiredProviderString(message.id, "message identifier"),
    externalThreadId: requiredProviderString(message.threadId, "thread identifier"),
    senderAddress: sender,
    recipientAddresses: splitEmailAddresses(headers.get("to") ?? ""),
    ccAddresses: splitEmailAddresses(headers.get("cc") ?? ""),
    subject: normalizeSubject(headers.get("subject") ?? "(No subject)"),
    text: normalizeEmailText(text),
    receivedAt: new Date(Number(message.internalDate ?? Date.now())).toISOString(),
    automated: isAutomatedEmail(headers)
  };
}

function normalizeOutlookMessage(message: OutlookMessage): NormalizedProviderEmail {
  const headers = new Map(
    (message.internetMessageHeaders ?? []).map((header) => [
      header.name?.toLowerCase() ?? "",
      header.value ?? ""
    ])
  );
  const content = message.body?.content ?? message.bodyPreview ?? "(No text content)";
  return {
    externalMessageId: requiredProviderString(message.id, "message identifier"),
    externalThreadId: requiredProviderString(message.conversationId, "thread identifier"),
    senderAddress: requiredProviderString(message.from?.emailAddress?.address, "sender address"),
    recipientAddresses: recipientAddresses(message.toRecipients),
    ccAddresses: recipientAddresses(message.ccRecipients),
    subject: normalizeSubject(message.subject ?? "(No subject)"),
    text: normalizeEmailText(
      message.body?.contentType?.toLowerCase() === "html" ? htmlToText(content) : content
    ),
    receivedAt: new Date(message.receivedDateTime ?? Date.now()).toISOString(),
    automated: isAutomatedEmail(headers)
  };
}

function createRfc822Message(input: EmailProviderSendRequest): string {
  if (input.attachments.length > 0) return createMultipartRfc822Message(input);
  const headers = [
    `From: ${input.senderAddress}`,
    `To: ${input.recipientAddress}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Message-ID: <${sanitizeHeader(input.idempotencyKey)}@grogoni.com>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit"
  ];
  return `${headers.join("\r\n")}\r\n\r\n${input.text.replace(/\r?\n/gu, "\r\n")}`;
}

function createMultipartRfc822Message(input: EmailProviderSendRequest): string {
  const boundary = `grogoni-${createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 24)}`;
  const headers = [
    `From: ${input.senderAddress}`,
    `To: ${input.recipientAddress}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Message-ID: <${sanitizeHeader(input.idempotencyKey)}@grogoni.com>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ];
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${input.text.replace(/\r?\n/gu, "\r\n")}`,
    ...input.attachments.map(
      (attachment) =>
        `--${boundary}\r\nContent-Type: ${sanitizeMimeType(attachment.mimeType)}; name="${sanitizeFilename(attachment.filename)}"\r\nContent-Disposition: attachment; filename="${sanitizeFilename(attachment.filename)}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapBase64(attachment.contentBase64)}`
    ),
    `--${boundary}--`
  ];
  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
}

function outlookAttachments(
  attachments: EmailProviderAttachment[]
): Array<Record<string, unknown>> {
  return attachments.map((attachment) => ({
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: attachment.filename,
    contentType: attachment.mimeType,
    contentBytes: attachment.contentBase64
  }));
}

function sanitizeFilename(value: string): string {
  return value.replace(/[\r\n"\\/]/gu, "-").slice(0, 120) || "attachment";
}

function sanitizeMimeType(value: string): string {
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(value) ? value : "application/octet-stream";
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/gu)?.join("\r\n") ?? "";
}

function extractGmailBody(part: GmailMessagePart | undefined): string {
  if (part === undefined) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const text = extractGmailBody(child);
    if (text !== "") return text;
  }
  if (part.mimeType === "text/html" && part.body?.data)
    return htmlToText(decodeBase64Url(part.body.data));
  return "";
}

function normalizeEmailText(value: string): string {
  const withoutQuotes = value
    .replace(/\r/gu, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .split(/\nOn .+wrote:\s*$/iu)[0]
    ?.trim();
  return (withoutQuotes || "(No new text content)").slice(0, 4000);
}

function htmlToText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(/<\/p\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/[ \t]+/gu, " ")
    .trim();
}

function isAutomatedEmail(headers: Map<string, string>): boolean {
  const autoSubmitted = headers.get("auto-submitted")?.toLowerCase() ?? "";
  const precedence = headers.get("precedence")?.toLowerCase() ?? "";
  return (
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    ["bulk", "junk", "list"].includes(precedence) ||
    headers.has("list-id")
  );
}

function splitEmailAddresses(value: string): string[] {
  return value
    .split(",")
    .map(extractEmailAddress)
    .filter((address) => address !== "");
}

function extractEmailAddress(value: string): string {
  const match = value.match(/<([^<>\s]+@[^<>\s]+)>|([^\s<>(),;]+@[^\s<>(),;]+)/u);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function recipientAddresses(recipients: OutlookRecipient[] | undefined): string[] {
  return (recipients ?? [])
    .map((recipient) => recipient.emailAddress?.address?.trim() ?? "")
    .filter((address) => address !== "");
}

function normalizeSubject(value: string): string {
  return (
    value
      .replace(/^(?:\s*re:\s*)+/giu, "Re: ")
      .trim()
      .slice(0, 200) || "(No subject)"
  );
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n<>]/gu, "-").slice(0, 180);
}

function encodeHeader(value: string): string {
  const safe = value.replace(/[\r\n]/gu, " ").trim();
  return /^[\x20-\x7e]*$/u.test(safe)
    ? safe
    : `=?UTF-8?B?${Buffer.from(safe).toString("base64")}?=`;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function isConfigured(configuration: ProviderConfiguration): boolean {
  return configuration.clientId !== "" && configuration.clientSecret !== "";
}

function firstEnvironmentValue(environment: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return "";
}

function requiredProviderString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EmailProviderClientError(
      "EMAIL_PROVIDER_UNAVAILABLE",
      `Provider ${label} is missing.`
    );
  }
  return value.trim();
}

function optionalProviderString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizeFetchLimit(value: number | undefined): number {
  if (value === undefined) return 25;
  return Number.isSafeInteger(value) ? Math.min(100, Math.max(1, value)) : 25;
}
