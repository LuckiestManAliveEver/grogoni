/**
 * Horizontal swipe on the chat: left opens the contact book, right opens the shop.
 * Pure rules, so the gesture is decided the same way in tests and on a phone.
 */
export type SwipeDirection = "left" | "right";

export interface SwipePoint {
  x: number;
  y: number;
  time: number;
}

/** Shortest horizontal travel that counts as a swipe, in CSS pixels. */
export const swipeMinDistance = 72;
/** Horizontal travel must be at least this many times the vertical travel (not a scroll). */
export const swipeMinRatio = 2;
/** A slower drag is reading or selecting, not swiping. */
export const swipeMaxDuration = 600;
/**
 * Touches starting this close to a screen edge belong to the OS back/forward gesture (Android's
 * back zone reaches about 40 dp at its highest sensitivity).
 */
export const swipeEdgeGutter = 40;

export function classifySwipe(
  start: SwipePoint,
  end: SwipePoint,
  viewportWidth: number
): SwipeDirection | null {
  if (start.x < swipeEdgeGutter || start.x > viewportWidth - swipeEdgeGutter) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (end.time - start.time > swipeMaxDuration) return null;
  if (Math.abs(dx) < swipeMinDistance) return null;
  if (Math.abs(dx) < swipeMinRatio * Math.abs(dy)) return null;
  return dx < 0 ? "left" : "right";
}

/**
 * Touches that start where the finger is already doing something else (typing, picking text,
 * scrolling a row sideways, inside a dialog or menu, or a control that opts out) never navigate.
 */
export function swipeStartsOnInteractiveElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable='true'], [data-swipe-ignore], dialog, [role='dialog'], [role='menu']"
    ) !== null
  ) {
    return true;
  }
  for (let node: Element | null = target; node !== null; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
  }
  return false;
}

/**
 * Swipes navigate only from the bare chat. An open module, the workspace, an inbox covering the
 * chat on a phone, or any sheet, menu or dialog over it (the marketplace sheet, recycle bin, new
 * chat form, SMS handoff, forward picker, message menu, message edit) keeps its own gestures.
 */
export function chatSwipeEnabled(state: {
  moduleOpen: boolean;
  workspaceOpen: boolean;
  inboxCoversChat: boolean;
  overlays: boolean[];
}): boolean {
  return (
    !state.moduleOpen &&
    !state.workspaceOpen &&
    !state.inboxCoversChat &&
    state.overlays.every((open) => !open)
  );
}

/** Text is selected: a fast drag is moving a selection handle, not swiping. */
export function textSelectionActive(): boolean {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString().length > 0;
}
