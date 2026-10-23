import { useStackedModuleSwipe } from "./hooks/useStackedModuleSwipe";
import { MobileChatPanel } from "./MobileChatPanel";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { nextFocusTargetForTab } from "./stacked-module-behavior";
import {
  isFocusInsideAnotherStackedModule,
  isTopmostStackedModule,
  promoteStackedModuleAndBackdrop,
  registerStackedModule,
  unregisterStackedModule
} from "./stacked-module-stack";

const focusableSelector =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface StackedModuleProps {
  children: ReactNode;
  embedded?: boolean;
  className?: string;
  moduleId: string;
  open: boolean;
  title: string;
  onClose: () => void;
}

export function StackedModule({
  children,
  embedded = false,
  className = "",
  moduleId,
  open,
  title,
  onClose
}: StackedModuleProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const { startSwipe, finishSwipe, cancelSwipe } = useStackedModuleSwipe(onClose);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || embedded) return;
    const appRoot = document.getElementById("root");
    const rootWasInert = appRoot?.hasAttribute("inert") ?? false;
    const previousAriaHidden = appRoot?.getAttribute("aria-hidden") ?? null;
    appRoot?.setAttribute("inert", "");
    appRoot?.setAttribute("aria-hidden", "true");
    const activeElementBeforeMount = document.activeElement;
    returnFocusRef.current =
      activeElementBeforeMount instanceof HTMLElement ? activeElementBeforeMount : null;
    registerStackedModule(moduleId, () => panelRef.current);

    // A module that mounts while focus is already inside a *different* open module (e.g. the
    // conversation inbox silently becoming its own StackedModule on a resize, while the user is
    // still working in the already-open Workspace dialog) must not yank focus or Tab/Escape
    // ownership away from where the user actually is - see stacked-module-stack.ts. It still
    // becomes topmost the moment something inside it is genuinely focused (the focusin listener
    // below), just not automatically on mount.
    const canStealInitialFocus = !isFocusInsideAnotherStackedModule(
      moduleId,
      activeElementBeforeMount
    );
    let frameId: number | null = null;
    if (canStealInitialFocus) {
      promoteStackedModuleAndBackdrop(moduleId, backdropRef.current);
      frameId = window.requestAnimationFrame(() => panelRef.current?.focus());
    }

    function handleFocusIn(event: FocusEvent) {
      if (event.target instanceof Node && panelRef.current?.contains(event.target) === true) {
        promoteStackedModuleAndBackdrop(moduleId, backdropRef.current);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      // Only the module that currently owns focus traps keys - see stacked-module-stack.ts.
      // Without this, two simultaneously-open modules each install a listener here, and both act
      // on the same keypress.
      if (!isTopmostStackedModule(moduleId)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || panelRef.current === null) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(focusableSelector)
      );
      const target = nextFocusTargetForTab(
        focusable,
        document.activeElement,
        panelRef.current,
        event.shiftKey
      );
      if (target !== null) {
        event.preventDefault();
        target.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn);
      unregisterStackedModule(moduleId);
      if (!rootWasInert) appRoot?.removeAttribute("inert");
      if (previousAriaHidden === null) appRoot?.removeAttribute("aria-hidden");
      else appRoot?.setAttribute("aria-hidden", previousAriaHidden);
      returnFocusRef.current?.focus();
    };
  }, [open, moduleId, embedded]);

  if (!open) return null;

  if (embedded)
    return (
      <MobileChatPanel moduleId={moduleId} className={className} title={title} onClose={onClose}>
        {children}
      </MobileChatPanel>
    );

  return createPortal(
    <div
      className="stacked-module-backdrop"
      data-module-id={moduleId}
      ref={backdropRef}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`stacked-module ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${moduleId}-title`}
        tabIndex={-1}
        ref={panelRef}
      >
        <div
          className="stacked-module-heading"
          onPointerDown={startSwipe}
          onPointerUp={finishSwipe}
          onPointerCancel={cancelSwipe}
        >
          <span className="stacked-module-drag-handle" aria-hidden="true" />
          <h2 id={`${moduleId}-title`}>{title}</h2>
          <button type="button" onClick={onClose} aria-label={`Close ${title}`}>
            ×
          </button>
        </div>
        <div className="stacked-module-content">{children}</div>
      </section>
    </div>,
    document.body
  );
}
