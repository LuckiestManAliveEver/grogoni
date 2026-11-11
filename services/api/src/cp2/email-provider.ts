import { Cp2Error } from "./store.js";

export interface EmailOtpInput {
  challengeId: string;
  code: string;
  expiresAt: string;
  to: string;
}

export interface EncryptedMessageEmailInput {
  conversationId: string;
  messageId: string;
  openUrl: string;
  to: string;
}

export interface RecoveryNotificationInput {
  to: string;
  sessionId: string;
  credential: "PIN" | "password";
  /** `browser_approved`: a logged-in device let a browser in (trusted-device recovery approval). */
  kind?: "credential_reset" | "browser_approved";
}

export interface EmailProvider {
  readonly name: string;
  readonly exposesDevOtp: boolean;
  sendOtp(input: EmailOtpInput): Promise<void>;
  sendRecoveryNotification?(input: RecoveryNotificationInput): Promise<"sent" | "failed">;
  sendEncryptedMessageNotification(input: EncryptedMessageEmailInput): Promise<"sent" | "failed">;
}

export class EmailDeliveryError extends Cp2Error {
  constructor(
    readonly providerStatus: number,
    readonly providerCode: string
  ) {
    super(502, "email_delivery_failed", "The email API rejected the message.");
  }
}

interface ResendEmailConfiguration {
  apiKey: string;
  from: string;
}

class LocalEmailProvider implements EmailProvider {
  readonly name = "local";
  readonly exposesDevOtp = true;

  async sendRecoveryNotification(input: RecoveryNotificationInput): Promise<"sent" | "failed"> {
    void input;
    return "sent";
  }

  async sendOtp(input: EmailOtpInput): Promise<void> {
    void input;
  }

  async sendEncryptedMessageNotification(
    input: EncryptedMessageEmailInput
  ): Promise<"sent" | "failed"> {
    void input;
    return "sent";
  }
}

class UnconfiguredEmailProvider implements EmailProvider {
  async sendRecoveryNotification(input: RecoveryNotificationInput): Promise<"sent" | "failed"> {
    void input;
    return "failed";
  }

  readonly name = "email_unconfigured";
  readonly exposesDevOtp = false;

  async sendOtp(input: EmailOtpInput): Promise<void> {
    void input;
    throw new Cp2Error(
      503,
      "email_api_unconfigured",
      "Email delivery is not configured on the server."
    );
  }

  async sendEncryptedMessageNotification(
    input: EncryptedMessageEmailInput
  ): Promise<"sent" | "failed"> {
    void input;
    return "failed";
  }
}

class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  readonly exposesDevOtp = false;

  constructor(private readonly configuration: ResendEmailConfiguration) {}

  async sendOtp(input: EmailOtpInput): Promise<void> {
    await this.send({
      idempotencyKey: `otp-${input.challengeId}`,
      subject: "Your Grogoni verification code",
      text:
        `Your Grogoni verification code is ${input.code}.\n\n` +
        `It expires at ${input.expiresAt}. If you did not request this code, ignore this email.`,
      to: input.to
    });
  }

  async sendEncryptedMessageNotification(
    input: EncryptedMessageEmailInput
  ): Promise<"sent" | "failed"> {
    try {
      await this.send({
        idempotencyKey: `message-${input.messageId}`,
        subject: "New end-to-end encrypted message on Grogoni",
        text:
          "You have a new end-to-end encrypted Grogoni message. " +
          "For your privacy, the message text is not included in this email.\n\n" +
          `Open Grogoni to decrypt it: ${input.openUrl}`,
        to: input.to
      });
      return "sent";
    } catch {
      return "failed";
    }
  }

  async sendRecoveryNotification(input: RecoveryNotificationInput): Promise<"sent" | "failed"> {
    try {
      await this.send(
        input.kind === "browser_approved"
          ? {
              idempotencyKey: `recovery-approval-${input.sessionId}`,
              subject: "A browser was let in to your Grogoni account",
              text: "One of your logged-in devices approved a new browser, and it is now logged in to your Grogoni account. If this was not you, within 24 hours open Grogoni on that device, go to Settings, Login & security, Approve a browser, and choose Undo, this wasn't me. That signs the browser out and removes anything it added.",
              to: input.to
            }
          : {
              idempotencyKey: `recovery-${input.sessionId}`,
              subject: `Your Grogoni account ${input.credential} was reset`,
              text: `Your Grogoni ${input.credential} was reset using an enrolled recovery method. Other sessions were signed out. If this was not you, open https://grogoni.com and review your trusted devices and passkeys.`,
              to: input.to
            }
      );
      return "sent";
    } catch {
      return "failed";
    }
  }

  private async send(input: {
    idempotencyKey: string;
    subject: string;
    text: string;
    to: string;
  }): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      // Bounded: notification jobs send while holding a database lock.
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${this.configuration.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey
      },
      body: JSON.stringify({
        from: this.configuration.from,
        to: [input.to],
        subject: input.subject,
        text: input.text
      })
    });

    if (!response.ok) {
      throw new Cp2Error(502, "email_delivery_failed", "The email API rejected the message.");
    }
  }
}

export function createEmailProviderFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): EmailProvider {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.GROGONI_EMAIL_FROM?.trim();

  if (apiKey && from) {
    return new ResendEmailProvider({ apiKey, from });
  }

  return env.NODE_ENV?.trim() === "production"
    ? new UnconfiguredEmailProvider()
    : new LocalEmailProvider();
}
