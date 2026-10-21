import {
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode
} from "libphonenumber-js";
import type { MessageComposerChannel, MessageHandoffStatus } from "@grogoni/shared-types";

export const smsNativeSendingEnabled = false;
export const singleSmsCharacterWarningThreshold = 160;

export interface OpenSmsComposerResult {
  channel: "sms_external_app";
  status: Extract<MessageHandoffStatus, "composer_opened" | "no_sms_app" | "unsupported">;
  errorCode: string | null;
  nativeBridgeUsed: boolean;
}

export interface SmsComposerBridge {
  openSmsComposer(
    recipient: string,
    body: string
  ): Promise<void | {
    status?: "composer_opened" | "no_sms_app";
    errorCode?: string | null;
  }>;
}

export type AndroidSmsComposerBridge = SmsComposerBridge;

export interface SmsComposerEnvironment {
  nativeBridge?: SmsComposerBridge;
  navigate: (uri: string) => void;
  userAgent: string;
}

export class SmsRecipientError extends Error {
  readonly code = "invalid_recipient";

  constructor(message: string) {
    super(message);
    this.name = "SmsRecipientError";
  }
}

export function selectMessageComposerChannel(input: {
  isGrogoniRecipient: boolean;
  smsRequested: boolean;
}): MessageComposerChannel {
  if (input.smsRequested) return "sms_external_app";
  return input.isGrogoniRecipient ? "grogoni" : "unsupported";
}

export function normalizeSmsRecipient(recipient: string, defaultCountry?: CountryCode): string {
  const rawRecipient = recipient.trim();
  if (rawRecipient.length === 0) {
    throw new SmsRecipientError("Enter a telephone number.");
  }
  if (/^grogoni\s*:/i.test(rawRecipient) || /[a-z]/i.test(rawRecipient)) {
    throw new SmsRecipientError("A Grogoni shop ID is not a telephone number.");
  }

  const digits = rawRecipient.replace(/\D/g, "");
  if (digits.length === 0) {
    throw new SmsRecipientError("Enter a valid telephone number.");
  }

  let candidate = rawRecipient;
  if (rawRecipient.startsWith("+")) {
    candidate = `+${digits}`;
  } else if (defaultCountry !== undefined) {
    const callingCode = getCountryCallingCode(defaultCountry);
    candidate = digits.startsWith(callingCode) ? `+${digits}` : rawRecipient;
  }

  const parsed = parsePhoneNumberFromString(candidate, defaultCountry);
  if (!parsed?.isValid()) {
    throw new SmsRecipientError("Enter a valid telephone number.");
  }
  return parsed.number;
}

export function buildSmsHandoffRequest(
  recipient: string,
  label: string,
  body: string,
  defaultCountry?: CountryCode
): { body: string; label: string; recipient: string } {
  let normalizedCandidate = "";
  try {
    normalizedCandidate = normalizeSmsRecipient(recipient, defaultCountry);
  } catch {
    // The confirmation sheet collects or corrects a missing contact number.
  }
  return {
    body,
    label: label.trim() || "SMS recipient",
    recipient: normalizedCandidate || recipient
  };
}

export function buildExternalSmsUri(recipient: string, body: string, userAgent = ""): string {
  if (!/^\+[1-9]\d{6,14}$/.test(recipient)) {
    throw new SmsRecipientError("Normalize the telephone number before opening the SMS app.");
  }
  // Apple's documented sms: scheme accepts a recipient only. Keep the text available to copy.
  if (/iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(userAgent)) return `sms:${recipient}`;
  return `sms:${recipient}?body=${encodeURIComponent(body)}`;
}

export function browserSmsComposerEnvironment(): SmsComposerEnvironment {
  const bridge = window as Window & {
    GrogoniAndroid?: AndroidSmsComposerBridge;
    GrogoniDevice?: SmsComposerBridge;
  };
  const nativeBridge = bridge.GrogoniDevice ?? bridge.GrogoniAndroid;
  return {
    ...(nativeBridge === undefined ? {} : { nativeBridge }),
    navigate: (uri) => window.location.assign(uri),
    userAgent: navigator.userAgent
  };
}

export async function openSmsComposer(
  recipient: string,
  body: string,
  environment: SmsComposerEnvironment = browserSmsComposerEnvironment()
): Promise<OpenSmsComposerResult> {
  if (environment.nativeBridge !== undefined) {
    try {
      const result = await environment.nativeBridge.openSmsComposer(recipient, body);
      if (result?.status === "no_sms_app") {
        return {
          channel: "sms_external_app",
          status: "no_sms_app",
          errorCode: result.errorCode ?? "no_sms_app",
          nativeBridgeUsed: true
        };
      }
      return {
        channel: "sms_external_app",
        status: "composer_opened",
        errorCode: null,
        nativeBridgeUsed: true
      };
    } catch {
      return {
        channel: "sms_external_app",
        status: "no_sms_app",
        errorCode: "no_sms_app",
        nativeBridgeUsed: true
      };
    }
  }

  try {
    // Browser names cannot establish whether an SMS handler (including a linked phone) exists.
    environment.navigate(buildExternalSmsUri(recipient, body, environment.userAgent));
    return {
      channel: "sms_external_app",
      status: "composer_opened",
      errorCode: null,
      nativeBridgeUsed: false
    };
  } catch {
    return {
      channel: "sms_external_app",
      status: "no_sms_app",
      errorCode: "no_sms_app",
      nativeBridgeUsed: false
    };
  }
}

export function isLongSmsBody(body: string): boolean {
  return body.length > singleSmsCharacterWarningThreshold;
}
