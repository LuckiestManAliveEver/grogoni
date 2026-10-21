import { useEffect, useState } from "react";

import { type BeforeInstallPromptEvent } from "./grogoni-application-shared";

const INSTALL_PROMPT_DISMISSED_KEY = "grogoni-install-prompt-dismissed";

export function useInstallPrompt() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissedInstallPrompt, setDismissedInstallPrompt] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const canInstall =
    installPrompt !== null && !isStandaloneWebApp() && !dismissedInstallPrompt;

  useEffect(() => {
    function handleBeforeInstallPrompt(event: Event) {
      if (dismissedInstallPrompt) {
        return;
      }
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    }

    function handleAppInstalled() {
      setInstallPrompt(null);
      try {
        window.localStorage.removeItem(INSTALL_PROMPT_DISMISSED_KEY);
      } catch {
        // Ignore storage errors while preserving operational behavior.
      }
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, [dismissedInstallPrompt]);

  async function installApp() {
    if (installPrompt === null) {
      return;
    }

    try {
      window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "true");
    } catch {
      // Ignore storage errors while preserving installation flow.
    }

    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
    setDismissedInstallPrompt(true);
  }

  function dismissInstallPrompt() {
    setInstallPrompt(null);
    setDismissedInstallPrompt(true);
    try {
      window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "true");
    } catch {
      // Ignore storage errors while preserving installation flow.
    }
  }

  return {
    canInstall,
    installApp,
    dismissInstallPrompt
  };
}

export function isStandaloneWebApp(): boolean {
  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };

  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigatorWithStandalone.standalone === true
  );
}

export async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard !== undefined) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}
