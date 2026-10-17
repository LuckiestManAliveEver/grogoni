import { useEffect, useRef, type RefObject } from "react";

import {
  classifySwipe,
  swipeStartsOnInteractiveElement,
  textSelectionActive,
  type SwipePoint
} from "../swipe-navigation";

interface SwipeNavigationOptions {
  enabled: boolean;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
}

/** One-finger horizontal swipes on `target`; see swipe-navigation.ts for what counts. */
export function useSwipeNavigation(
  target: RefObject<HTMLElement | null>,
  options: SwipeNavigationOptions
): void {
  // Read the latest callbacks at gesture end without re-binding listeners every render.
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const element = target.current;
    if (element === null) return;
    let start: SwipePoint | null = null;

    function onTouchStart(event: TouchEvent) {
      const touch = event.touches[0];
      start =
        event.touches.length === 1 &&
        touch !== undefined &&
        latest.current.enabled &&
        !swipeStartsOnInteractiveElement(event.target) &&
        !textSelectionActive()
          ? { x: touch.clientX, y: touch.clientY, time: event.timeStamp }
          : null;
    }
    function onTouchMove(event: TouchEvent) {
      // A second finger means pinch or zoom, never a swipe.
      if (event.touches.length > 1) start = null;
    }
    function onTouchEnd(event: TouchEvent) {
      const touch = event.changedTouches[0];
      const from = start;
      start = null;
      if (from === null || touch === undefined || !latest.current.enabled || textSelectionActive())
        return;
      const direction = classifySwipe(
        from,
        { x: touch.clientX, y: touch.clientY, time: event.timeStamp },
        window.innerWidth
      );
      if (direction === "left") latest.current.onSwipeLeft();
      else if (direction === "right") latest.current.onSwipeRight();
    }
    function onTouchCancel() {
      start = null;
    }

    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: true });
    element.addEventListener("touchend", onTouchEnd, { passive: true });
    element.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [target]);
}
