/// <reference types="vite/client" />

import type { AndroidSmsComposerBridge, SmsComposerBridge } from "./messaging/sms-handoff";

declare global {
  const __APP_NAME__: string;
  const __APP_VERSION__: string;
  const __BUILD_TIMESTAMP__: string;
  const __DEPLOYMENT_ENV__: string;
  const __DEBUG_UI__: boolean;
  const __GIT_COMMIT_SHA__: string;

  interface Window {
    GrogoniAndroid?: AndroidSmsComposerBridge;
    GrogoniDevice?: SmsComposerBridge;
  }
}

export {};
