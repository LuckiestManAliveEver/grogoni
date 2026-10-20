import { browserPlatformShareEnvironment } from "./platform-handoff";

export const externalMessagingApps = [
  { id: "whatsapp", label: "WhatsApp", url: "https://web.whatsapp.com/" },
  { id: "telegram", label: "Telegram", url: "https://web.telegram.org/" },
  { id: "messenger", label: "Messenger", url: "https://www.messenger.com/" },
  { id: "instagram", label: "Instagram", url: "https://www.instagram.com/direct/inbox/" },
  { id: "tiktok", label: "TikTok", url: "https://www.tiktok.com/messages" },
  { id: "x", label: "X", url: "https://x.com/messages" }
] as const;
export type ExternalMessagingApp = (typeof externalMessagingApps)[number]["id"];

/** The user selects the recipient and sends in the external app. No delivery is inferred. */
export async function openExternalMessagingApp(
  appId: ExternalMessagingApp,
  text: string,
  environment: {
    open: (url: string) => boolean;
    copy?: ((text: string) => Promise<void>) | undefined;
  } = {
    open: (url) => window.open(url, "_blank", "noopener,noreferrer") !== null,
    copy: browserPlatformShareEnvironment().writeClipboard
  }
): Promise<{ opened: boolean; copied: boolean }> {
  const app = externalMessagingApps.find((candidate) => candidate.id === appId);
  if (!app || !text.trim()) return { opened: false, copied: false };
  // Open during the click gesture; awaiting clipboard permissions first loses popup permission.
  const opened = environment.open(app.url);
  let copied = false;
  try {
    if (environment.copy) {
      await environment.copy(text);
      copied = true;
    }
  } catch {
    /* The picker retains a selectable copy of the draft. */
  }
  return { opened, copied };
}
