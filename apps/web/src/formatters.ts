import type {
  AgentModelBindingSummary,
  ChannelProvider,
  InferenceProvider
} from "@grogoni/shared-types";
import { type ChatAttachment } from "./app-shell";

import {
  type AgentSettings,
  type RuntimeTurnResult,
  type StorefrontCareRequestType
} from "./grogoni-application-shared";

export function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-KE", {
    currency: "KES",
    style: "currency"
  }).format(value);
}

export function formatOptionalMoney(value: number | null): string {
  return value === null ? "not set" : formatMoney(value);
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-KE", {
    dateStyle: "medium"
  }).format(new Date(value));
}

export function formatLatency(value: number): string {
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(1)} s`;
}

export function formatMessageTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(new Date(timestamp).toDateString() === new Date().toDateString()
      ? {}
      : { month: "short", day: "numeric" })
  }).format(new Date(timestamp));
}

export function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 102.4) / 10} KB`;
  }

  return `${Math.round(size / 104857.6) / 10} MB`;
}

export function formatModelBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "Size unavailable";
  if (bytes >= 1000 ** 3) return `${(bytes / 1000 ** 3).toFixed(2)} GB`;
  return `${Math.round(bytes / 1000 ** 2)} MB`;
}

export function formatModelParameters(parameters: number | null): string {
  if (parameters === null || !Number.isFinite(parameters)) return "Parameters unknown";
  if (parameters >= 1_000_000_000) {
    return `${(parameters / 1_000_000_000).toFixed(parameters < 10_000_000_000 ? 1 : 0)}B parameters`;
  }
  return `${Math.round(parameters / 1_000_000)}M parameters`;
}

export function formatChannelProvider(provider: ChannelProvider): string {
  const labels: Record<ChannelProvider, string> = {
    grogoni: "Grogoni",
    telegram: "Telegram",
    whatsapp: "WhatsApp",
    messenger: "Messenger",
    instagram: "Instagram",
    tiktok: "TikTok",
    x: "X",
    sms: "SMS",
    native_sms: "SMS via Android",
    email: "Email"
  };
  return labels[provider];
}

export function formatCareRequestType(type: StorefrontCareRequestType): string {
  return type === "registration"
    ? "Registration"
    : `${type[0]?.toUpperCase() ?? ""}${type.slice(1)}`;
}

export function formatAttachmentCategory(category: ChatAttachment["category"]): string {
  if (category === "image") {
    return "Image";
  }

  if (category === "video") {
    return "Video";
  }

  if (category === "document") {
    return "Document";
  }

  if (category === "audio") {
    return "Audio";
  }

  return "File";
}

export function formatAgentDisplayName(agent: AgentSettings): string {
  return agent.name.trim().length === 0 ? "Your agent" : agent.name.trim();
}

export function formatInferenceRuntimeLabel(runtime: InferenceProvider["runtime"]): string {
  return (
    {
      "native-llama-cpp": "Installed app model",
      "browser-webgpu": "Browser WebGPU",
      "browser-wasm": "Browser WASM",
      "owner-node": "Shop-owner device"
    } satisfies Record<InferenceProvider["runtime"], string>
  )[runtime];
}

export function formatModelStatus(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^\w/, (character) => character.toUpperCase());
}

export function formatExecutionTarget(value: AgentModelBindingSummary["executionTarget"]): string {
  return (
    {
      local: "this computer's local runtime",
      vercel: "Grogoni backend",
      backend: "Grogoni backend",
      "remote-shop-device": "signed-in shop device",
      "browser-local": "this device's browser",
      "installed-app": "the installed Grogoni app"
    } satisfies Record<AgentModelBindingSummary["executionTarget"], string>
  )[value];
}

export function formatRuntimeTurnStatus(result: RuntimeTurnResult): string {
  const runtimeStatus = result.turn.status.replace("_", " ");
  const model = result.turn.model;

  if (model === null) {
    return `Runtime ${runtimeStatus}`;
  }
  if (model.fallbackUsed) {
    const reason =
      model.errorCode === "model_provider_unconfigured"
        ? "selected model has no configured inference provider"
        : `model ${model.status}`;
    return `Model fallback: ${reason}. Deterministic runtime ${runtimeStatus}.`;
  }
  return `${model.provider ?? "Agent"} model processed · Runtime ${runtimeStatus}`;
}

export function escapeCsvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
