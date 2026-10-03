import { useEffect, useRef, useState } from "react";
import type { ComputerApproval, ComputerSession } from "@grogoni/shared-types";
import { apiCloudFetch, readApiBaseUrl } from "./lib/api";

export function ComputerRuntimeCard(props: { businessId: string; conversationId: string }) {
  const [session, setSession] = useState<ComputerSession | null>(null);
  const [url, setUrl] = useState("https://example.com");
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [typing, setTyping] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [approval, setApproval] = useState<ComputerApproval | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!session || ["COMPLETED", "FAILED", "CANCELLED"].includes(session.status)) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(
          `${readApiBaseUrl()}/v1/computer/sessions/${encodeURIComponent(session.id)}/frame?t=${Date.now()}`,
          { credentials: "include", cache: "no-store" }
        );
        if (!response.ok) return;
        const next = URL.createObjectURL(await response.blob());
        if (!active) return URL.revokeObjectURL(next);
        setFrameUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return next;
        });
        const state = await apiCloudFetch<ComputerSession>(
          `/v1/computer/sessions/${encodeURIComponent(session.id)}`
        );
        const pending = await apiCloudFetch<{ approval: ComputerApproval | null }>(
          `/v1/computer/sessions/${encodeURIComponent(session.id)}/approval`
        );
        if (active) {
          setSession(state);
          setApproval(pending.approval);
        }
      } catch {
        /* the next poll reconciles transient worker/network failures */
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [session?.id, session?.status]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Computer session failed.");
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    await run(async () => {
      const profile = await apiCloudFetch<{ id: string }>("/v1/computer/profiles", {
        method: "POST",
        body: { businessId: props.businessId, label: "Web workspace" }
      });
      const created = await apiCloudFetch<ComputerSession>("/v1/computer/sessions", {
        method: "POST",
        body: {
          businessId: props.businessId,
          conversationId: props.conversationId,
          taskId: props.conversationId,
          profileId: profile.id,
          externalSurface: { id: "generic-web", type: "web" }
        }
      });
      setSession(created);
    });
  }

  async function sendAction(body: Record<string, unknown>) {
    if (!session) return;
    const result = await apiCloudFetch<{ observation?: { url: string | null } }>(
      `/v1/computer/sessions/${encodeURIComponent(session.id)}/actions`,
      { method: "POST", body }
    );
    if (result.observation?.url)
      setSession((current) =>
        current ? { ...current, currentUrl: result.observation!.url } : current
      );
  }

  if (!session)
    return (
      <section className="computer-runtime-launch" aria-label="Computer runtime">
        <button type="button" onClick={() => void start()} disabled={busy}>
          Open browser
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </section>
    );

  const human = session.controlMode === "HUMAN_CONTROLLED";
  return (
    <section className="computer-runtime-card" aria-label="Live browser">
      <header>
        <strong>{session.currentUrl ? new URL(session.currentUrl).hostname : "Browser"}</strong>
        <span>{session.status.replaceAll("_", " ").toLowerCase()}</span>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(() =>
            sendAction({
              kind: "navigate",
              target: { url },
              semanticIntent: "Navigate to user-provided URL"
            })
          );
        }}
      >
        <input
          aria-label="Browser address"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={busy || human}
        />
        <button type="submit" disabled={busy || human} aria-label="Navigate">
          Go
        </button>
      </form>
      <div className="computer-live-view">
        {frameUrl ? (
          <img
            ref={imageRef}
            src={frameUrl}
            alt="Live browser view"
            onClick={(event) => {
              if (!human || !imageRef.current) return;
              const rect = imageRef.current.getBoundingClientRect();
              void sendAction({
                kind: "click",
                actor: "human",
                target: {
                  x: Math.round(((event.clientX - rect.left) * 1280) / rect.width),
                  y: Math.round(((event.clientY - rect.top) * 800) / rect.height)
                },
                semanticIntent: "Human click"
              });
            }}
          />
        ) : (
          <div className="computer-frame-loading">Connecting...</div>
        )}
      </div>
      {approval ? (
        <aside className="computer-approval" aria-label="Computer action approval">
          <strong>Approve external action?</strong>
          <p>{approval.proposedAction.semanticIntent ?? approval.proposedAction.kind}</p>
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await apiCloudFetch(`/v1/computer/approvals/${approval.id}`, {
                    method: "POST",
                    body: { decision: "approve" }
                  });
                  setApproval(null);
                })
              }
            >
              Approve
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await apiCloudFetch(`/v1/computer/approvals/${approval.id}`, {
                    method: "POST",
                    body: { decision: "reject" }
                  });
                  setApproval(null);
                })
              }
            >
              Cancel
            </button>
          </div>
        </aside>
      ) : null}
      {human ? (
        <form
          className="computer-human-input"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await sendAction({
                kind: "type",
                actor: "human",
                target: {},
                value: typing,
                semanticIntent: "Human keyboard input"
              });
              setTyping("");
            });
          }}
        >
          <input
            aria-label="Type in browser"
            value={typing}
            onChange={(event) => setTyping(event.target.value)}
          />
          <button type="submit" disabled={!typing || busy}>
            Type
          </button>
        </form>
      ) : null}
      <footer>
        <span>
          <i aria-hidden="true" />
          {human ? "You are controlling" : "Grogoni is controlling"}
        </span>
        <div>
          {human ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setSession(
                    (
                      await apiCloudFetch<{ session: ComputerSession }>(
                        `/v1/computer/sessions/${session.id}/control/release`,
                        { method: "POST" }
                      )
                    ).session
                  )
                )
              }
            >
              Return to Grogoni
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setSession(
                    await apiCloudFetch<ComputerSession>(
                      `/v1/computer/sessions/${session.id}/control/take`,
                      { method: "POST" }
                    )
                  )
                )
              }
            >
              Take control
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await apiCloudFetch(`/v1/computer/sessions/${session.id}`, { method: "DELETE" });
                setSession(null);
              })
            }
          >
            Stop
          </button>
        </div>
      </footer>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
