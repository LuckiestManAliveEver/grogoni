const unexplainedErrorMessage =
  "Grogoni could not complete this request because the server did not provide an explanation. Please try again.";
export const accountSyncInitializationMessage =
  "We could not finish setting up your account. Please try again.";

export function getUserFacingErrorMessage(
  error: unknown,
  fallback = unexplainedErrorMessage
): string {
  const code = readErrorCode(error);
  const codeMessage = code === null ? null : authenticationErrorMessages[code];
  if (codeMessage !== undefined && codeMessage !== null) {
    return codeMessage;
  }
  const message = readErrorMessage(error);

  if (message === null) {
    return fallback;
  }

  if (/failed to fetch|networkerror|network request failed|load failed/i.test(message)) {
    return "Grogoni could not reach the server. Check your internet connection and try again.";
  }

  if (/aborterror|the operation was aborted|request was aborted/i.test(message)) {
    return "The request was cancelled before it finished. Try again when you are ready.";
  }

  return message;
}

const authenticationErrorMessages: Record<string, string> = {
  pin_not_set: "This account doesn't have a PIN yet. Create one now.",
  passkey_pin_recovery_required: "Verify your passkey again before changing your PIN.",
  passkey_unknown: "That passkey is not linked to a Grogoni account.",
  passkey_authentication_invalid: "Grogoni could not verify that passkey. Try again.",
  auth_refresh_required: "Sign in to start a new session on this device.",
  auth_refresh_revoked: "This session is no longer active. Sign in again.",
  auth_refresh_expired: "This session has expired. Sign in again.",
  auth_refresh_reuse_detected:
    "This session was closed because its refresh credential was reused. Sign in again.",
  ACCOUNT_SYNC_INITIALIZATION_FAILED:
    "We couldn't finish signing you in because account data could not be saved. Try again.",
  pin_invalid: "The PIN you entered is incorrect.",
  pin_locked: "PIN attempts are temporarily locked. Wait a moment and try again.",
  pin_rate_limited: "PIN attempts are temporarily locked. Wait a moment and try again."
};

export type AuthenticationPromptTarget = "login" | "signup";

export function getAuthenticationPromptTarget(message: string): AuthenticationPromptTarget | null {
  const normalized = message.trim().toLowerCase();

  if (
    /(?:^|_)(?:signup|registration)_required$/.test(normalized) ||
    /\bplease (?:sign[ -]?up|register|create (?:an? )?account)\b/.test(normalized) ||
    /\b(?:sign[ -]?up|signup|register)(?: or (?:sign|log)[ -]?in)? (?:before|to)\b/.test(
      normalized
    ) ||
    (/\b(sign[ -]?up|signup|registration|create (?:an? )?account)\b/.test(normalized) &&
      /\b(required|must|need(?:ed)?|to continue)\b/.test(normalized))
  ) {
    return "signup";
  }

  if (
    /(?:^|_)(?:auth|authentication|login|signin|session)_required$/.test(normalized) ||
    /\bauthentication (?:is )?required\b/.test(normalized) ||
    /\bnot authenticated\b/.test(normalized) ||
    /\b(?:valid )?(?:account|owner )?session (?:is )?required\b/.test(normalized) ||
    /\bsession (?:is |has )?(?:missing|expired)\b/.test(normalized) ||
    /\b(?:please|need to|must) (?:sign|log)[ -]?in\b/.test(normalized) ||
    /\byou (?:need|must) to (?:sign|log)[ -]?in\b/.test(normalized) ||
    /\b(?:sign|log)[ -]?in (?:before|to)\b/.test(normalized) ||
    /\b(?:sign[ -]?in|log[ -]?in) (?:is )?required\b/.test(normalized) ||
    /\b(?:sign[ -]?in|log[ -]?in) (?:and try again|to continue)\b/.test(normalized) ||
    /\bmust be (?:signed|logged) in\b/.test(normalized) ||
    /\bmust be authenticated\b/.test(normalized) ||
    /\blogin pin verification (?:is )?required\b/.test(normalized)
  ) {
    return "login";
  }

  return null;
}

export function getAccountLoginErrorMessage(error: unknown): string {
  const message = getUserFacingErrorMessage(error, accountSyncInitializationMessage);

  if (
    /account_sync_changes|check constraint|databaseerror|postgres(?:ql)?|new row for relation/iu.test(
      message
    )
  ) {
    return accountSyncInitializationMessage;
  }

  return message;
}

export async function getResponseErrorMessage(response: Response): Promise<string> {
  const payload = await readResponsePayload(response);
  const explanation = readErrorMessage(payload);

  if (explanation !== null) {
    return explanation;
  }

  return getHttpStatusExplanation(response.status, response.statusText);
}

function readErrorMessage(error: unknown): string | null {
  if (typeof error === "string") {
    return nonEmpty(error);
  }

  if (error instanceof Error) {
    return nonEmpty(error.message);
  }

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const record = error as Record<string, unknown>;
  for (const key of ["message", "detail", "error", "reason"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  if (Array.isArray(record.errors)) {
    const messages = record.errors
      .map((entry) => readErrorMessage(entry))
      .filter((entry): entry is string => entry !== null);
    if (messages.length > 0) {
      return messages.join(" ");
    }
  }

  return null;
}

function readErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() !== "" ? code : null;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (text.trim() === "") {
      return null;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

function getHttpStatusExplanation(status: number, statusText: string): string {
  const explanations: Record<number, string> = {
    400: "The server could not process the request because some submitted information is invalid.",
    401: "Your session is missing or has expired. Sign in and try again.",
    403: "Your account does not have permission to perform this action.",
    404: "The requested account, conversation, or record could not be found.",
    409: "The request conflicts with a newer change. Refresh the latest information and try again.",
    413: "The uploaded file is larger than the server allows.",
    415: "The uploaded file format is not supported.",
    422: "The submitted information could not be accepted. Review the fields and try again.",
    429: "Too many requests were made in a short time. Wait a moment before trying again.",
    500: "The server encountered an unexpected problem while processing the request.",
    502: "The server could not get a valid response from a required service.",
    503: "A required service is temporarily unavailable or has not been configured.",
    504: "A required service took too long to respond."
  };

  return (
    explanations[status] ??
    `The request could not be completed because the server returned HTTP ${status}${
      statusText.trim() === "" ? "" : ` (${statusText})`
    }.`
  );
}

function nonEmpty(value: string): string | null {
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}
