import { useEffect, useRef, useState } from "react";
import type { ShopCapabilitiesSummary, ShopCapabilityModule } from "@grogoni/shared-types";

import { getJson } from "./api-helpers";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { shopHubCopy, shopHubLanguage, type ShopHubLanguage } from "./shop-hub-copy";
import { surfacesForModule, type ShopHubSurface } from "./shop-hub-surfaces";
import { ShopHubSkeleton } from "./ShopHubEntryCard";
import { ShopHubIcon } from "./ShopHubIcon";
import { createStorefrontUrl, isGrogoniId } from "./grogoniid-and-storefront";

export interface ShopHubProps {
  businessId: string;
  businessName: string;
  /** The shop's public Grogoni ID, or anything else while the shop has none yet. */
  grogoniId: string;
  language?: ShopHubLanguage;
  onOpenSurface: (surface: ShopHubSurface) => void;
  /** Pre-fills the chat composer; the agent runs the tool through the same runtime as chat. */
  onAskAgent: (draft: string) => void;
}

type LoadState = "loading" | "ready" | "offline" | "error";

/** The chat command that invokes a registry tool - the same # command the composer offers. */
export function askAgentDraft(toolName: string): string {
  return `#${toolName} `;
}

/**
 * The Shop Hub: every capability the shop runs on, rendered entirely from
 * GET /businesses/:businessId/capabilities (the canonical tool registry, filtered by role). A tile
 * opens its module as a sub-view of the same workspace drawer, with Back - the pattern the
 * drawer's catalogue and dashboard views already use (a second StackedModule nested inside this
 * one would not take the stack's focus; see stacked-module-stack.ts). Nothing here lists tools.
 */
export function ShopHub({
  businessId,
  businessName,
  grogoniId,
  language = shopHubLanguage(),
  onOpenSurface,
  onAskAgent
}: ShopHubProps) {
  const copy = shopHubCopy(language);
  const path = `/businesses/${businessId}/capabilities`;
  const revision = useApiMutationRevision(`/businesses/${businessId}`);
  const [hub, setHub] = useState<ShopCapabilitiesSummary | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [reload, setReload] = useState(0);
  const [openModuleId, setOpenModuleId] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState("");
  const hubRef = useRef<HTMLElement | null>(null);
  const lastOpenedModuleRef = useRef<string | null>(null);

  // Back from a module returns focus to the tile that opened it.
  useEffect(() => {
    if (openModuleId !== null || lastOpenedModuleRef.current === null) return;
    hubRef.current
      ?.querySelector<HTMLButtonElement>(
        `.shop-hub-tile[data-module-id="${lastOpenedModuleRef.current}"]`
      )
      ?.focus();
  }, [openModuleId]);

  function openModuleView(moduleId: string) {
    lastOpenedModuleRef.current = moduleId;
    setOpenModuleId(moduleId);
  }

  useEffect(() => {
    let cancelled = false;
    getJson<ShopCapabilitiesSummary>(path, (fresh) => {
      if (!cancelled) setHub(fresh);
    })
      .then((loaded) => {
        if (cancelled) return;
        setHub(loaded);
        setState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setState(
          typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "error"
        );
      });
    return () => {
      cancelled = true;
    };
  }, [path, revision, reload]);

  const modules = hub?.categories.flatMap((category) => category.modules) ?? [];
  const openModule = modules.find((module) => module.id === openModuleId) ?? null;
  const storefrontUrl = isGrogoniId(grogoniId) ? createStorefrontUrl(grogoniId) : null;

  function openSurface(surface: ShopHubSurface) {
    setOpenModuleId(null);
    onOpenSurface(surface);
  }

  function fix(module: ShopCapabilitiesSummary["needsAttention"][number]) {
    const primary = surfacesForModule(module.moduleId)[0];
    if (primary === undefined) openModuleView(module.moduleId);
    else openSurface(primary);
  }

  async function copyLink() {
    if (storefrontUrl === null) return;
    try {
      await navigator.clipboard.writeText(storefrontUrl);
      setLinkNotice(copy.copied);
    } catch {
      setLinkNotice(storefrontUrl);
    }
  }

  async function shareLink() {
    if (storefrontUrl === null) return;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: businessName, url: storefrontUrl });
        return;
      } catch {
        // Dismissed or unsupported target: fall back to copying.
      }
    }
    await copyLink();
  }

  if (openModule !== null) {
    return (
      <section className="shop-hub" aria-label={copy.title} lang={language} ref={hubRef}>
        <ShopHubModuleDetail
          module={openModule}
          language={language}
          onBack={() => setOpenModuleId(null)}
          onOpenSurface={openSurface}
          onAskAgent={(draft) => {
            setOpenModuleId(null);
            onAskAgent(draft);
          }}
        />
      </section>
    );
  }

  return (
    <section className="shop-hub" aria-label={copy.title} lang={language} ref={hubRef}>
      <header className="shop-hub-header">
        <div className="shop-hub-identity">
          <span className="shop-hub-kiondo">
            <ShopHubIcon icon="kiondo" />
          </span>
          <div className="shop-hub-identity-text">
            <h3>{businessName}</h3>
            {storefrontUrl !== null ? (
              <p className="shop-hub-slug">
                <span>{storefrontUrl.replace(/^https?:\/\//u, "")}</span>
              </p>
            ) : null}
          </div>
        </div>
        <div className="shop-hub-actions">
          {storefrontUrl !== null ? (
            <>
              <button type="button" className="shop-hub-action primary" onClick={shareLink}>
                {copy.share}
              </button>
              <button type="button" className="shop-hub-action" onClick={copyLink}>
                {copy.copyLink}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="shop-hub-action"
            onClick={() =>
              openSurface({
                kind: "workspace",
                view: "storefrontPreview",
                label: "storefrontPreview"
              })
            }
          >
            {copy.viewAsCustomer}
          </button>
        </div>
        <p className="shop-hub-link-notice" role="status" aria-live="polite">
          {linkNotice}
        </p>
      </header>

      {state === "offline" || state === "error" ? (
        <div className="shop-hub-notice" role="status">
          <p>
            {state === "offline"
              ? hub === null
                ? copy.offline
                : copy.offlineCached
              : copy.loadFailed}
          </p>
          <button type="button" className="shop-hub-action" onClick={() => setReload((n) => n + 1)}>
            {copy.retry}
          </button>
        </div>
      ) : null}

      {hub === null ? (
        state === "loading" ? (
          <ShopHubSkeleton label={copy.loading} />
        ) : null
      ) : (
        <>
          {hub.needsAttention.length > 0 ? (
            <section className="shop-hub-attention" aria-label={copy.needsAttention}>
              <h4 className="shop-hub-section-label">{copy.needsAttention}</h4>
              <ul>
                {hub.needsAttention.map((item) => (
                  <li key={item.moduleId}>
                    <span>{item.reason[language]}</span>
                    <button
                      type="button"
                      className="shop-hub-fix"
                      aria-label={`${copy.fix}: ${item.label[language]}`}
                      onClick={() => fix(item)}
                    >
                      {copy.fix}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {hub.categories.length === 0 ? <p className="shop-hub-empty">{copy.empty}</p> : null}

          {hub.categories.map((category) => (
            <section
              className="shop-hub-section"
              key={category.id}
              aria-label={category.label[language]}
            >
              <h4 className="shop-hub-section-label">{category.label[language]}</h4>
              <div className="shop-hub-grid">
                {category.modules.map((module) => (
                  <button
                    type="button"
                    className="shop-hub-tile"
                    data-module-id={module.id}
                    key={module.id}
                    onClick={() => openModuleView(module.id)}
                  >
                    <span className="shop-hub-tile-icon">
                      <ShopHubIcon icon={module.icon} />
                    </span>
                    <strong>{module.label[language]}</strong>
                    <small>{module.description[language]}</small>
                    {module.setup.state === "ready" ? null : (
                      <span className={`shop-hub-badge ${module.setup.state}`}>
                        {copy.state[module.setup.state]}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </section>
  );
}

function ShopHubModuleDetail({
  module,
  language,
  onBack,
  onOpenSurface,
  onAskAgent
}: {
  module: ShopCapabilityModule;
  language: ShopHubLanguage;
  onBack: () => void;
  onOpenSurface: (surface: ShopHubSurface) => void;
  onAskAgent: (draft: string) => void;
}) {
  const copy = shopHubCopy(language);
  const surfaces = surfacesForModule(module.id);
  const backRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => backRef.current?.focus(), []);
  return (
    <div
      className="shop-hub-detail"
      data-module-id={module.id}
      role="region"
      aria-label={module.label[language]}
    >
      <div className="shop-hub-detail-heading">
        <button type="button" className="shop-hub-back" ref={backRef} onClick={onBack}>
          <span aria-hidden="true">←</span> {copy.back}
        </button>
        <h3>
          <span className="shop-hub-tile-icon">
            <ShopHubIcon icon={module.icon} />
          </span>
          {module.label[language]}
        </h3>
      </div>
      <p className="shop-hub-detail-description">{module.description[language]}</p>
      {module.setup.reason !== null ? (
        <p className={`shop-hub-detail-setup ${module.setup.state}`}>
          <span className={`shop-hub-badge ${module.setup.state}`}>
            {copy.state[module.setup.state]}
          </span>{" "}
          {module.setup.reason[language]}
        </p>
      ) : null}
      {surfaces.length > 0 ? (
        <div className="shop-hub-surfaces">
          {surfaces.map((surface, index) => (
            <button
              type="button"
              className={`shop-hub-action${index === 0 ? " primary" : ""}`}
              key={`${surface.kind}:${surface.view}`}
              onClick={() => onOpenSurface(surface)}
            >
              {copy.surface[surface.label]}
            </button>
          ))}
        </div>
      ) : null}
      {module.tools.length > 0 ? (
        <>
          <p className="shop-hub-detail-intro">{copy.askAgentIntro}</p>
          <ul className="shop-hub-tools">
            {module.tools.map((tool) => (
              <li key={tool.name}>
                <span>
                  {tool.label[language]}
                  {tool.requiresConfirmation ? <small>{copy.needsConfirmation}</small> : null}
                </span>
                <button
                  type="button"
                  className="shop-hub-ask"
                  aria-label={`${copy.askAgent}: ${tool.label[language]}`}
                  onClick={() => onAskAgent(askAgentDraft(tool.name))}
                >
                  {copy.askAgent}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : surfaces.length === 0 ? (
        <p className="shop-hub-detail-intro">{copy.noTools}</p>
      ) : null}
    </div>
  );
}
