import type { CSSProperties } from "react";

// Design D: every shop gets a kanga-style pattern drawn from its immutable business id, so the same
// shop looks the same on every device and in every list without uploading or downloading an image.
// The pattern is pure CSS (design-d.css); this module only picks the motif and the two colours.

export type KangaMotif = "mshazari" | "mistari" | "madoa" | "almasi";

export interface KangaIdentity {
  motif: KangaMotif;
  /** The pattern colour. */
  ink: string;
  /** The ground the pattern is drawn on. */
  ground: string;
}

const motifs: readonly KangaMotif[] = ["mshazari", "mistari", "madoa", "almasi"];

// Grogoni brand tokens only (styles.css :root), paired so the pattern stays visible on its ground.
const palettes: readonly { ink: string; ground: string }[] = [
  { ink: "#c2543f", ground: "#3a1f18" },
  { ink: "#e3a13c", ground: "#2f2010" },
  { ink: "#8fd8bd", ground: "#1f4438" },
  { ink: "#e3a13c", ground: "#3a1f18" },
  { ink: "#f4f2ee", ground: "#2f6b56" },
  { ink: "#c2543f", ground: "#2f2010" }
];

/** 32-bit FNV-1a: small, stable across engines, and spreads similar ids apart. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function kangaIdentity(seed: string): KangaIdentity {
  const hash = fnv1a(seed);
  const motif = motifs[hash % motifs.length] ?? "mshazari";
  const palette = palettes[(hash >>> 8) % palettes.length] ?? { ink: "#c2543f", ground: "#3a1f18" };
  return { motif, ink: palette.ink, ground: palette.ground };
}

export function kangaStyle(identity: KangaIdentity): CSSProperties {
  return { "--kanga-ink": identity.ink, "--kanga-ground": identity.ground } as CSSProperties;
}

/** Up to two initials from a shop name ("Mama Njeri's Duka" → "MN"), "?" when there is none. */
export function shopInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  const initials = words
    .slice(0, 2)
    .map((word) => Array.from(word.replace(/^[^\p{L}\p{N}]+/u, ""))[0] ?? "")
    .join("")
    .toUpperCase();
  return initials.length > 0 ? initials : "?";
}

/**
 * The shop on the other side of a conversation, for the kanga avatar: a BUSINESS conversation's
 * shop when it is not the viewer's own (for the shop's own staff the other side is the customer,
 * so their own shop's pattern would mislabel every customer chat).
 */
export function counterpartShopId(
  conversation:
    { conversationType?: string | undefined; activeShopId: string | null } | null | undefined,
  ownBusinessId: string | null | undefined
): string | null {
  if (conversation === null || conversation === undefined) return null;
  if (conversation.conversationType !== "BUSINESS") return null;
  const shopId = conversation.activeShopId;
  if (shopId === null || shopId.length === 0) return null;
  return shopId === ownBusinessId ? null : shopId;
}
