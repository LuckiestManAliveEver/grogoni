import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelCapability } from "@grogoni/shared-types";
import { ChannelGatewayError } from "./channel-errors.js";
import type {
  CanonicalInboundChannelMessage,
  ChannelSendResult,
  ChannelWebhookInput,
  MessagingChannelAdapter,
  OutboundChannelMessage
} from "./channel-gateway.js";

type Provider = "whatsapp" | "messenger" | "instagram" | "tiktok" | "x" | "sms";
type Configuration = { businessId: string; values: NodeJS.ProcessEnv };
const prefixes: Record<Provider, string> = {
  whatsapp: "WHATSAPP",
  messenger: "MESSENGER",
  instagram: "INSTAGRAM",
  tiktok: "TIKTOK",
  x: "X",
  sms: "TWILIO"
};
const required: Record<Provider, string[]> = {
  whatsapp: ["ACCESS_TOKEN", "PHONE_NUMBER_ID", "PHONE_NUMBER", "APP_SECRET", "VERIFY_TOKEN"],
  messenger: ["ACCESS_TOKEN", "PAGE_ID", "APP_SECRET", "VERIFY_TOKEN"],
  instagram: ["ACCESS_TOKEN", "ACCOUNT_ID", "USERNAME", "APP_SECRET", "VERIFY_TOKEN"],
  tiktok: ["ACCESS_TOKEN", "BUSINESS_ID"],
  x: ["USER_ACCESS_TOKEN", "USER_ID", "CONSUMER_SECRET"],
  sms: ["ACCOUNT_SID", "AUTH_TOKEN", "FROM_NUMBER", "WEBHOOK_URL"]
};

/** Secret configuration is scoped to a shop; a platform token never enables another tenant. */
export function readExternalMessagingConfigurations(
  environment: NodeJS.ProcessEnv
): Configuration[] {
  const configurations: Configuration[] = [];
  if (environment.EXTERNAL_MESSAGING_SHOP_ID?.trim())
    configurations.push({
      businessId: environment.EXTERNAL_MESSAGING_SHOP_ID.trim(),
      values: environment
    });
  if (environment.EXTERNAL_MESSAGING_CONNECTIONS_JSON?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(environment.EXTERNAL_MESSAGING_CONNECTIONS_JSON);
    } catch {
      throw new Error("EXTERNAL_MESSAGING_CONNECTIONS_JSON must contain valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(
        "EXTERNAL_MESSAGING_CONNECTIONS_JSON must map shop IDs to provider settings."
      );
    for (const [businessId, values] of Object.entries(parsed)) {
      if (
        !businessId.trim() ||
        !values ||
        typeof values !== "object" ||
        Array.isArray(values) ||
        Object.values(values).some((value) => typeof value !== "string")
      )
        throw new Error("External messaging settings must contain shop IDs and string settings.");
      if (configurations.some((configuration) => configuration.businessId === businessId))
        throw new Error("Duplicate external messaging shop configuration.");
      configurations.push({ businessId, values: values as NodeJS.ProcessEnv });
    }
  }
  return configurations;
}

export function createExternalChannelAdapters(
  environment: NodeJS.ProcessEnv,
  fetcher: typeof fetch
): MessagingChannelAdapter[] {
  const configurations = readExternalMessagingConfigurations(environment);
  return (Object.keys(prefixes) as Provider[]).map(
    (provider) => new ExternalChannelAdapter(provider, configurations, fetcher)
  );
}

class ExternalChannelAdapter implements MessagingChannelAdapter {
  constructor(
    readonly provider: Provider,
    private readonly configurations: Configuration[],
    private readonly fetcher: typeof fetch
  ) {
    const accounts = new Set<string>();
    for (const configuration of configurations) {
      if (!this.configured(configuration) || provider === "tiktok") continue;
      const id = this.ownId(configuration);
      if (accounts.has(id))
        throw new Error(`Each ${provider} sender account must be bound to exactly one shop.`);
      accounts.add(id);
    }
  }
  private value(configuration: Configuration, key: string): string {
    return configuration.values[`${prefixes[this.provider]}_${key}`]?.trim() ?? "";
  }
  private configured(configuration: Configuration): boolean {
    return required[this.provider].every((key) => this.value(configuration, key) !== "");
  }
  private configuration(businessId?: string): Configuration | undefined {
    return this.configurations.find(
      (configuration) => configuration.businessId === businessId && this.configured(configuration)
    );
  }
  private capabilities(): ChannelCapability[] {
    return this.provider === "sms"
      ? ["CAN_SEND", "CAN_RECEIVE", "CAN_REPLY", "CAN_INITIATE", "REQUIRES_OPT_IN"]
      : [
          "CAN_SEND",
          "CAN_RECEIVE",
          "CAN_REPLY",
          "REQUIRES_EXISTING_THREAD",
          ...(this.provider === "whatsapp" ? ["REQUIRES_OPT_IN" as const] : [])
        ];
  }
  readiness(context?: { businessId?: string }) {
    const configured =
      this.provider !== "tiktok" && this.configuration(context?.businessId) !== undefined;
    return {
      provider: this.provider,
      configured,
      authorized: configured,
      capabilities: this.provider === "tiktok" ? [] : this.capabilities(),
      status: configured ? ("available" as const) : ("unavailable" as const),
      configurationRequirement:
        this.provider === "tiktok"
          ? "Use Share to apps for TikTok. Direct delivery requires approved Business Messaging partner access."
          : configured
            ? null
            : `Connect ${this.provider} to this shop using ${required[this.provider].map((key) => `${prefixes[this.provider]}_${key}`).join(", ")}.`
    };
  }
  getCapabilities() {
    return this.provider === "tiktok" ? [] : this.capabilities();
  }
  private ownId(configuration: Configuration): string {
    return this.value(
      configuration,
      this.provider === "whatsapp"
        ? "PHONE_NUMBER_ID"
        : this.provider === "messenger"
          ? "PAGE_ID"
          : this.provider === "instagram"
            ? "ACCOUNT_ID"
            : this.provider === "x"
              ? "USER_ID"
              : this.provider === "sms"
                ? "FROM_NUMBER"
                : "BUSINESS_ID"
    );
  }
  createLinkUrl(token: string, businessId?: string): string | null {
    const configuration = this.configuration(businessId);
    if (!configuration) return null;
    const text = encodeURIComponent(`link ${token}`);
    if (this.provider === "whatsapp") {
      const phone = this.value(configuration, "PHONE_NUMBER").replace(/\D/g, "");
      return phone ? `https://wa.me/${phone}?text=${text}` : null;
    }
    if (this.provider === "messenger")
      return `https://m.me/${encodeURIComponent(this.ownId(configuration))}?ref=${encodeURIComponent(token)}`;
    if (this.provider === "sms") return `sms:${this.ownId(configuration)}?body=${text}`;
    if (this.provider === "x")
      return `https://x.com/messages/compose?recipient_id=${encodeURIComponent(this.ownId(configuration))}`;
    const username = this.value(configuration, "USERNAME");
    if (!/^[A-Za-z0-9_.]{1,64}$/.test(username)) return null;
    return this.provider === "instagram"
      ? `https://ig.me/m/${username}`
      : `https://www.tiktok.com/@${username}`;
  }
  webhookChallenge(query: Record<string, unknown>): string | null {
    if (this.provider === "x" && typeof query.crc_token === "string") {
      const secrets = this.configurations
        .filter((configuration) => this.configured(configuration))
        .map((configuration) => this.value(configuration, "CONSUMER_SECRET"))
        .filter(Boolean);
      const secret = [...new Set(secrets)];
      return secret.length === 1
        ? JSON.stringify({
            response_token: `sha256=${createHmac("sha256", secret[0]!).update(query.crc_token).digest("base64")}`
          })
        : null;
    }
    if (
      !["whatsapp", "messenger", "instagram"].includes(this.provider) ||
      query["hub.mode"] !== "subscribe" ||
      typeof query["hub.challenge"] !== "string" ||
      typeof query["hub.verify_token"] !== "string"
    )
      return null;
    return this.configurations.some(
      (configuration) =>
        this.configured(configuration) &&
        equal(query["hub.verify_token"] as string, this.value(configuration, "VERIFY_TOKEN"))
    )
      ? query["hub.challenge"]
      : null;
  }
  async sendMessage(request: OutboundChannelMessage): Promise<ChannelSendResult> {
    const configuration =
      this.provider === "tiktok" ? undefined : this.configuration(request.businessId);
    if (!configuration)
      throw new ChannelGatewayError(
        "CHANNEL_NOT_CONNECTED",
        `${this.provider} is not connected to this shop.`
      );
    if (request.attachments?.length)
      throw new ChannelGatewayError(
        "CHANNEL_SEND_FAILED",
        "Use the connected mailbox to send document attachments."
      );
    if (["whatsapp", "messenger", "instagram"].includes(this.provider)) {
      const lastInbound = Date.parse(request.endpoint.lastInboundAt ?? "");
      if (!Number.isFinite(lastInbound) || Date.now() - lastInbound > 24 * 60 * 60_000)
        throw new ChannelGatewayError(
          "CHANNEL_REPLY_WINDOW_EXPIRED",
          "Ask the recipient to message the business again before sending a free-text reply."
        );
    }
    const recipient = request.endpoint.externalUserId;
    if (!recipient || /[\r\n]/.test(recipient))
      throw new ChannelGatewayError(
        "CHANNEL_IDENTITY_NOT_FOUND",
        "Choose a linked provider recipient."
      );
    let url: string;
    let headers: Record<string, string> = { "content-type": "application/json" };
    let body: string;
    const ownId = this.ownId(configuration);
    if (["whatsapp", "messenger", "instagram"].includes(this.provider)) {
      const version = configuration.values.META_GRAPH_VERSION?.trim() || "v25.0";
      if (!/^v\d+\.\d+$/.test(version) || !/^\d+$/.test(ownId))
        throw new ChannelGatewayError(
          "CHANNEL_NOT_CONNECTED",
          "Invalid Meta account configuration."
        );
      url = `https://${this.provider === "instagram" ? "graph.instagram.com" : "graph.facebook.com"}/${version}/${ownId}/messages`;
      headers.authorization = `Bearer ${this.value(configuration, "ACCESS_TOKEN")}`;
      body = JSON.stringify(
        this.provider === "whatsapp"
          ? {
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to: recipient,
              type: "text",
              text: { body: request.text, preview_url: false }
            }
          : {
              recipient: { id: recipient },
              ...(this.provider === "messenger" ? { messaging_type: "RESPONSE" } : {}),
              message: { text: request.text }
            }
      );
    } else if (this.provider === "x") {
      if (!/^\d+$/.test(recipient))
        throw new ChannelGatewayError(
          "CHANNEL_IDENTITY_NOT_FOUND",
          "A linked X user ID is required."
        );
      url = `https://api.x.com/2/dm_conversations/with/${recipient}/messages`;
      headers.authorization = `Bearer ${this.value(configuration, "USER_ACCESS_TOKEN")}`;
      body = JSON.stringify({ text: request.text });
    } else {
      const account = this.value(configuration, "ACCOUNT_SID");
      if (
        !/^AC[a-f0-9]{32}$/i.test(account) ||
        !/^\+[1-9]\d{6,14}$/.test(recipient) ||
        !/^\+[1-9]\d{6,14}$/.test(ownId)
      )
        throw new ChannelGatewayError(
          "CHANNEL_NOT_CONNECTED",
          "A Twilio account and valid sender and recipient numbers are required."
        );
      url = `https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`;
      headers = {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${account}:${this.value(configuration, "AUTH_TOKEN")}`).toString("base64")}`
      };
      body = new URLSearchParams({ To: recipient, From: ownId, Body: request.text }).toString();
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw new ChannelGatewayError(
        "CHANNEL_SEND_FAILED",
        `${this.provider} did not confirm acceptance. Check provider history before retrying.`
      );
    }
    const payload = object(await response.json().catch(() => null));
    if (!response.ok || payload.error) {
      const rateLimited = response.status === 429;
      const expired =
        response.status === 401 || response.status === 403 || object(payload.error).code === 190;
      throw new ChannelGatewayError(
        rateLimited
          ? "CHANNEL_RATE_LIMITED"
          : expired
            ? "PROVIDER_AUTH_EXPIRED"
            : "CHANNEL_SEND_FAILED",
        rateLimited
          ? `${this.provider} rate limited this message.`
          : expired
            ? `Reconnect ${this.provider} authorization.`
            : `${this.provider} rejected this message.`,
        rateLimited
      );
    }
    const data = object(payload.data);
    const messageId =
      this.provider === "whatsapp"
        ? object(array(payload.messages)[0]).id
        : this.provider === "x"
          ? data.dm_event_id
          : this.provider === "sms"
            ? payload.sid
            : payload.message_id;
    if (typeof messageId !== "string" || !messageId)
      throw new ChannelGatewayError(
        "CHANNEL_SEND_FAILED",
        `${this.provider} returned no message receipt. Check provider history before retrying.`
      );
    return {
      accepted: true,
      providerMessageId: messageId,
      status: this.provider === "sms" ? "queued" : "sent"
    };
  }
  parseWebhook(input: ChannelWebhookInput): CanonicalInboundChannelMessage[] {
    if (!input.rawBody)
      throw new ChannelGatewayError(
        "CHANNEL_WEBHOOK_INVALID",
        "The original webhook bytes are required."
      );
    const payload = object(input.payload);
    const matching = this.configurations.filter(
      (configuration) =>
        this.configured(configuration) && this.matchesAccount(configuration, payload)
    );
    const verified = matching.filter((configuration) => this.validSignature(configuration, input));
    if (!verified.length)
      throw new ChannelGatewayError("CHANNEL_WEBHOOK_INVALID", "Webhook authentication failed.");
    const messages = verified.flatMap((configuration) => this.inbound(configuration, payload));
    if (messages.length > 100)
      throw new ChannelGatewayError(
        "CHANNEL_RATE_LIMITED",
        "Split provider webhook batches into at most 100 messages.",
        true
      );
    return messages;
  }
  private matchesAccount(configuration: Configuration, payload: Record<string, unknown>): boolean {
    if (this.provider === "sms")
      return (
        payload.AccountSid === this.value(configuration, "ACCOUNT_SID") &&
        payload.To === this.ownId(configuration)
      );
    if (this.provider === "x") return payload.for_user_id === this.ownId(configuration);
    if (this.provider === "tiktok") return false;
    return array(payload.entry).some((value) => {
      const entry = object(value);
      return this.provider === "whatsapp"
        ? array(entry.changes).some(
            (change) =>
              object(object(change).value).metadata &&
              object(object(object(change).value).metadata).phone_number_id ===
                this.ownId(configuration)
          )
        : entry.id === this.ownId(configuration);
    });
  }
  private validSignature(configuration: Configuration, input: ChannelWebhookInput): boolean {
    if (this.provider === "sms") {
      const fields = object(input.payload);
      const value =
        this.value(configuration, "WEBHOOK_URL") +
        Object.keys(fields)
          .sort()
          .map((key) => key + String(fields[key]))
          .join("");
      return equal(
        header(input, "x-twilio-signature"),
        createHmac("sha1", this.value(configuration, "AUTH_TOKEN")).update(value).digest("base64")
      );
    }
    const secret = this.value(
      configuration,
      this.provider === "x" ? "CONSUMER_SECRET" : "APP_SECRET"
    );
    if (!secret) return false;
    const expected = createHmac("sha256", secret)
      .update(input.rawBody!)
      .digest(this.provider === "x" ? "base64" : "hex");
    return equal(
      header(input, this.provider === "x" ? "x-twitter-webhooks-signature" : "x-hub-signature-256"),
      `sha256=${expected}`
    );
  }
  private inbound(
    configuration: Configuration,
    payload: Record<string, unknown>
  ): CanonicalInboundChannelMessage[] {
    const result: CanonicalInboundChannelMessage[] = [];
    const push = (
      id: unknown,
      sender: unknown,
      conversation: unknown,
      text: unknown,
      token?: unknown,
      timestamp?: unknown
    ) => {
      if (
        typeof id !== "string" ||
        typeof sender !== "string" ||
        typeof conversation !== "string" ||
        typeof text !== "string" ||
        !text.trim()
      )
        return;
      if (text.length > 4000) return;
      result.push({
        provider: this.provider,
        businessId: configuration.businessId,
        externalUpdateId: id,
        externalMessageId: id,
        externalUserId: sender,
        externalConversationId: conversation,
        displayName: null,
        text,
        linkToken:
          typeof token === "string" && /^[A-Za-z0-9_-]{16,200}$/.test(token)
            ? token
            : (/^(?:link|\/start)\s+([A-Za-z0-9_-]{16,200})$/u.exec(text.trim())?.[1] ?? null),
        receivedAt: new Date(
          typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
            ? Math.min(timestamp, Date.now())
            : Date.now()
        ).toISOString()
      });
    };
    if (this.provider === "sms") {
      push(payload.MessageSid, payload.From, `${payload.To}:${payload.From}`, payload.Body);
      return result;
    }
    if (this.provider === "x") {
      for (const event of array(payload.direct_message_events).map(object)) {
        const message = object(event.message_create);
        if (object(message.target).recipient_id !== this.ownId(configuration)) continue;
        push(
          event.id,
          message.sender_id,
          `${this.ownId(configuration)}:${message.sender_id}`,
          object(message.message_data).text,
          undefined,
          Number(event.created_timestamp)
        );
      }
      return result;
    }
    if (this.provider === "tiktok") return result;
    for (const entry of array(payload.entry).map(object)) {
      if (this.provider === "whatsapp") {
        for (const change of array(entry.changes).map(object)) {
          const value = object(change.value);
          if (object(value.metadata).phone_number_id !== this.ownId(configuration)) continue;
          for (const message of array(value.messages).map(object))
            if (message.type === "text")
              push(
                message.id,
                message.from,
                `${this.ownId(configuration)}:${message.from}`,
                object(message.text).body,
                undefined,
                Number(message.timestamp) * 1000
              );
        }
      } else if (entry.id === this.ownId(configuration)) {
        for (const event of array(entry.messaging).map(object)) {
          const message = object(event.message);
          if (message.is_echo || object(event.recipient).id !== this.ownId(configuration)) continue;
          const sender = object(event.sender).id;
          const referral =
            object(event.referral).ref ?? object(object(event.postback).referral).ref;
          push(
            message.mid ??
              object(event.postback).mid ??
              (referral
                ? `ref:${sender}:${createHash("sha256").update(String(referral)).digest("hex")}`
                : undefined),
            sender,
            `${this.ownId(configuration)}:${sender}`,
            message.text ?? (referral ? `link ${referral}` : null),
            referral,
            Number(event.timestamp)
          );
        }
      }
    }
    return result;
  }
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function header(input: ChannelWebhookInput, name: string): string {
  const value = input.headers[name];
  return typeof value === "string" ? value : "";
}
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
