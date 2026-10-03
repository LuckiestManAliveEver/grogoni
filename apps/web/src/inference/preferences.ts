export interface ClientInferencePreferences {
  ownerNodeAllowed: boolean;
}

const storageKey = "grogoni.client-inference-preferences.v1";

export function readClientInferencePreferences(
  accountId: string,
  businessId: string
): ClientInferencePreferences {
  try {
    const records = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as unknown;
    if (!Array.isArray(records)) return defaultPreferences();
    const match = records.find(
      (record) =>
        typeof record === "object" &&
        record !== null &&
        (record as { accountId?: unknown }).accountId === accountId &&
        (record as { businessId?: unknown }).businessId === businessId
    );
    return normalizePreferences(match);
  } catch {
    return defaultPreferences();
  }
}

export function saveClientInferencePreferences(
  accountId: string,
  businessId: string,
  preferences: ClientInferencePreferences
): ClientInferencePreferences {
  const normalized = normalizePreferences(preferences);
  let records: unknown[] = [];
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as unknown;
    if (Array.isArray(stored)) records = stored;
  } catch {
    records = [];
  }
  const retained = records.filter(
    (record) =>
      !(
        typeof record === "object" &&
        record !== null &&
        (record as { accountId?: unknown }).accountId === accountId &&
        (record as { businessId?: unknown }).businessId === businessId
      )
  );
  localStorage.setItem(
    storageKey,
    JSON.stringify([
      ...retained,
      {
        accountId,
        businessId,
        ...normalized,
        updatedAt: new Date().toISOString()
      }
    ])
  );
  return normalized;
}

function normalizePreferences(value: unknown): ClientInferencePreferences {
  const record =
    typeof value === "object" && value !== null
      ? (value as Partial<ClientInferencePreferences>)
      : {};
  return {
    ownerNodeAllowed: record.ownerNodeAllowed === true
  };
}

function defaultPreferences(): ClientInferencePreferences {
  return {
    ownerNodeAllowed: false
  };
}
