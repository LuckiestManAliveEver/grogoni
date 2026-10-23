import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { shouldCloseStackedModuleFromSwipe } from "../stacked-module-behavior";
export function useStackedModuleSwipe(onClose: () => void) {
  const swipeStartYRef = useRef<number | null>(null);
  function startSwipe(event: ReactPointerEvent<HTMLDivElement>) {
    if (!event.isPrimary) return;
    if (
      event.target instanceof Element &&
      event.target.closest("button, a[href], input, select, textarea") !== null
    ) {
      return;
    }
    swipeStartYRef.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function finishSwipe(event: ReactPointerEvent<HTMLDivElement>) {
    const startY = swipeStartYRef.current;
    swipeStartYRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (startY !== null && shouldCloseStackedModuleFromSwipe(startY, event.clientY)) {
      onClose();
    }
  }

  return {
    startSwipe,
    finishSwipe,
    cancelSwipe: () => {
      swipeStartYRef.current = null;
    }
  };
}
