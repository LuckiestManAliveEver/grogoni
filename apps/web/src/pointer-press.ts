// Defers work until an in-progress pointer press has finished, after its click handler has run.
//
// Why: pressing a button blurs the focused input before the press produces its click. If the
// input's blur handler changes layout (PhoneNumberField's blur check inserts a "Full number" or
// error line), the button moves mid-press, the press ends over different content, and the browser
// drops the click. Running that blur work after the click keeps the button under the pointer.

let pressActive = false;
let queued: Array<() => void> = [];
let installed = false;
let releaseFallback: number | null = null;

// How long after pointerup a press may still produce its click. A touch tap fires pointerup
// before the compatibility mousedown that blurs the input, and before click; a drag never clicks.
const clickGraceMs = 500;

function finishPress() {
  if (!pressActive) return;
  pressActive = false;
  if (releaseFallback !== null) window.clearTimeout(releaseFallback);
  releaseFallback = null;
  // From click's capture phase, a zero timeout runs the queue after the click handler itself;
  // from the grace timer or window blur there is no click, and it runs on the next task.
  window.setTimeout(() => {
    const callbacks = queued;
    queued = [];
    for (const callback of callbacks) {
      // One failing callback must not drop the rest; its error still surfaces as uncaught.
      try {
        callback();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }, 0);
}

/** Starts tracking presses. Call before any blur that may need deferring (e.g. on mount). */
export function installPointerPressTracking(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "pointerdown",
    () => {
      pressActive = true;
      if (releaseFallback !== null) window.clearTimeout(releaseFallback);
      releaseFallback = null;
    },
    true
  );
  const awaitClick = () => {
    if (!pressActive) return;
    if (releaseFallback !== null) window.clearTimeout(releaseFallback);
    releaseFallback = window.setTimeout(finishPress, clickGraceMs);
  };
  document.addEventListener("pointerup", awaitClick, true);
  document.addEventListener("pointercancel", awaitClick, true);
  document.addEventListener("click", finishPress, true);
  // A press released outside the window may never report pointerup or click to the document.
  window.addEventListener("blur", finishPress);
}

/** Runs `callback` now, or after the current pointer press (and its click) if one is active. */
export function runAfterPointerPress(callback: () => void): void {
  if (!pressActive) {
    callback();
    return;
  }
  queued.push(callback);
}
