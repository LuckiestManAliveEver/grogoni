import type { ChatMessage } from "./app-shell";

/**
 * The 4-second foreground poll (GrogoniApplication.tsx) remaps the whole conversation thread into a
 * brand-new array on every tick, whether or not anything changed. Without this guard,
 * setChatMessages would hand ChatSurface a new array reference every 4 seconds even when the
 * conversation is unchanged - unnecessary churn while a generated card's own local form state
 * (e.g. an in-progress "Add product" draft) sits nearby in the same render tree. Content-compares
 * rather than reference-compares so an unrelated new message, edit, or reaction still replaces
 * the array as before.
 *
 * Deliberately dependency-free (only the ChatMessage type, erased at compile time) so it can be
 * imported and unit-tested directly - useChatInboxState.ts and its neighbors transitively import
 * grogoni-application-shared.ts, which reads module-level Vite build-time globals
 * (window.location, __APP_NAME__) that the root vitest config doesn't define.
 */
export function chatMessagesEqual(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
