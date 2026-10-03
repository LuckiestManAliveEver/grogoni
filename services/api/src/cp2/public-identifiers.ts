import type { OAuthProvider } from "@grogoni/shared-types";

export function providerDisplayName(provider: OAuthProvider): string {
  switch (provider) {
    case "facebook":
      return "Facebook";
    case "github":
      return "GitHub";
    case "google":
      return "Google";
    case "linkedin":
      return "LinkedIn";
    case "tiktok":
      return "TikTok";
    case "microsoft":
      return "Microsoft";
    case "apple":
      return "Apple";
    case "x":
      return "X";
  }
}
