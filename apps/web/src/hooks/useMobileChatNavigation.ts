import { useEffect, useRef, type TouchEvent } from "react";
import type { GrogoniMode } from "../app-shell";
export function useMobileChatNavigation({
  isCompactViewport,
  workspaceOpen,
  marketplaceShortcutOpen,
  isInboxOpen,
  mode,
  onCloseWorkspace,
  onCloseMarketplace,
  onInboxOpenChange,
  onOpenWorkspace,
  onOpenMarketplace
}: {
  isCompactViewport: boolean;
  workspaceOpen: boolean;
  marketplaceShortcutOpen: boolean;
  isInboxOpen: boolean;
  mode: GrogoniMode;
  onCloseWorkspace: () => void;
  onCloseMarketplace: () => void;
  onInboxOpenChange: (open: boolean) => void;
  onOpenWorkspace: () => void;
  onOpenMarketplace: (() => void) | undefined;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const surface = surfaceRef.current;
    const composerElement = surface?.querySelector<HTMLElement>(".composer");
    if (!surface || !composerElement || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      surface.style.setProperty(
        "--mobile-composer-height",
        `${composerElement.getBoundingClientRect().height}px`
      );
    });
    observer.observe(composerElement);
    return () => observer.disconnect();
  }, []);
  return {
    surfaceRef,
    onTouchStart: (event: TouchEvent<HTMLDivElement>) => {
      swipeStart.current = null;
      if (
        !isCompactViewport ||
        event.touches.length !== 1 ||
        (event.target instanceof Element &&
          event.target.closest(
            "input, textarea, select, button, a, [role='dialog'], .composer, [data-no-swipe]"
          ))
      )
        return;
      swipeStart.current = { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY };
    },
    onTouchCancel: () => {
      swipeStart.current = null;
    },
    onTouchEnd: (event: TouchEvent<HTMLDivElement>) => {
      const start = swipeStart.current;
      swipeStart.current = null;
      const end = event.changedTouches[0];
      if (!start || !end || event.touches.length > 0) return;
      const dx = end.clientX - start.x;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(end.clientY - start.y) * 1.5) return;
      if (dx > 0) {
        if (workspaceOpen) onCloseWorkspace();
        else if (marketplaceShortcutOpen) onCloseMarketplace();
        else {
          onInboxOpenChange(true);
        }
      } else {
        if (isInboxOpen) onInboxOpenChange(false);
        else if (mode === "seller") onOpenWorkspace();
        else onOpenMarketplace?.();
      }
    }
  };
}
