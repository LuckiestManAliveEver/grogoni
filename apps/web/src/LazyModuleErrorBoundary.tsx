import { Component, type ErrorInfo, type ReactNode } from "react";

import {
  currentDeploymentBuildId,
  isLazyModuleLoadError,
  logDeploymentRecoveryEvent,
  retryLazyModuleLoad
} from "./lazy-module-recovery";

export interface LazyModuleErrorBoundaryProps {
  children: ReactNode;
  label: string;
  moduleKey: string;
}

interface LazyModuleErrorBoundaryState {
  failed: boolean;
  staleBuild: boolean;
}

/**
 * The one error boundary every lazy-loaded surface (Account and Agent Settings included) renders
 * inside. It never reloads on its own - `loadLazyModuleWithRecovery` already attempted the single
 * guarded automatic reload before a rejected `lazy()` promise ever reaches here (see
 * apps/web/src/lazy-module-recovery.ts). This boundary only has to classify what it catches:
 *
 * - A stale-build chunk error that still reached render (recovery already attempted and either
 *   is offline or already used its one automatic attempt) gets the "app may have been updated"
 *   copy, with a manual reload button.
 * - Anything else is a genuine rendering exception in the surface itself, not a deployment issue,
 *   and must say so - reloading would not fix it and would misleadingly blame "an update".
 */
export class LazyModuleErrorBoundary extends Component<
  LazyModuleErrorBoundaryProps,
  LazyModuleErrorBoundaryState
> {
  override state: LazyModuleErrorBoundaryState = { failed: false, staleBuild: false };

  static getDerivedStateFromError(error: unknown): LazyModuleErrorBoundaryState {
    return { failed: true, staleBuild: isLazyModuleLoadError(error) };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    console.error(`[Grogoni] Unable to render ${this.props.moduleKey}.`, error, errorInfo);
    logDeploymentRecoveryEvent("frontend.chunk_load_failed", {
      component: this.props.moduleKey,
      route: typeof window === "undefined" ? "unknown" : window.location.pathname,
      buildId: currentDeploymentBuildId(),
      category: this.state.staleBuild ? "stale_build_confirmed" : "component_exception"
    });
  }

  private tryAgain = (): void => {
    this.setState({ failed: false, staleBuild: false });
  };

  private reload = (): void => {
    retryLazyModuleLoad(this.props.moduleKey);
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    if (this.state.staleBuild) {
      return (
        <section className="lazy-module-error" role="alert">
          <strong>{this.props.label} could not open.</strong>
          <p>The app may have been updated while this page was open.</p>
          <button type="button" onClick={this.reload}>
            Reload and try again
          </button>
        </section>
      );
    }

    return (
      <section className="lazy-module-error" role="alert">
        <strong>{this.props.label} hit an unexpected problem.</strong>
        <p>This looks like an application error, not an update - reloading may not fix it.</p>
        <button type="button" onClick={this.tryAgain}>
          Try again
        </button>
      </section>
    );
  }
}
