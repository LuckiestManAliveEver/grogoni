/**
 * First-run device access checklist. Android reports item ids and statuses
 * (contracts/device-permission-checklist.json); this module owns the wording.
 */
export type DevicePermissionStatus =
  "granted" | "not_requested" | "denied" | "blocked" | "unavailable";

export interface DevicePermissionItem {
  id: string;
  required: boolean;
  status: DevicePermissionStatus;
}

export interface DevicePermissionChecklist {
  version: number;
  completed: boolean;
  items: DevicePermissionItem[];
}

export const devicePermissionCopy: Record<string, { title: string; detail: string }> = {
  sms: {
    title: "Messages (SMS and MMS)",
    detail:
      "Make Grogoni your default SMS app so it can read, send and receive texts and picture messages with your SIM. Android may also turn on related access, such as Phonebook and Camera, when you choose this."
  },
  contacts: {
    title: "Phonebook",
    detail:
      "Show contact names in your messages and suggest recipients as you type. Grogoni only reads it here, on this phone, and never changes your contacts."
  },
  notifications: {
    title: "Notifications",
    detail: "Alert you when a message arrives. The alert never shows the message text."
  },
  camera: {
    title: "Camera",
    detail: "Take a photo with the camera when you add a product."
  },
  location: {
    title: "Location",
    detail:
      "Record a location, such as your shop or a delivery point, when you tap to use it. Grogoni never tracks you in the background."
  }
};

const statuses = new Set<DevicePermissionStatus>([
  "granted",
  "not_requested",
  "denied",
  "blocked",
  "unavailable"
]);

/** Accepts only a well-formed checklist; anything else (older host, browser) means "no checklist". */
export function parseDevicePermissionChecklist(value: unknown): DevicePermissionChecklist | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<DevicePermissionChecklist>;
  if (typeof candidate.completed !== "boolean" || !Array.isArray(candidate.items)) return null;
  const items = candidate.items.filter(
    (item): item is DevicePermissionItem =>
      typeof item === "object" &&
      item !== null &&
      typeof item.id === "string" &&
      item.id in devicePermissionCopy &&
      typeof item.required === "boolean" &&
      statuses.has(item.status)
  );
  if (items.length === 0) return null;
  return { version: Number(candidate.version) || 1, completed: candidate.completed, items };
}

export function checklistProgress(checklist: DevicePermissionChecklist) {
  const applicable = checklist.items.filter((item) => item.status !== "unavailable");
  const granted = applicable.filter((item) => item.status === "granted").length;
  const requiredMissing = applicable.filter(
    (item) => item.required && item.status !== "granted"
  ).length;
  const askable = applicable.filter(
    (item) => item.status === "not_requested" || item.status === "denied"
  ).length;
  return { granted, total: applicable.length, requiredMissing, askable };
}
