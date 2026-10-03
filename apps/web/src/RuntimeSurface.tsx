import { type RuntimeSessionSummary, type RuntimeTurnSummary } from "./grogoni-application-shared";

import { EmptyStateSurface } from "./EmptyStateSurface";

export interface RuntimeSurfaceProps {
  sessions: RuntimeSessionSummary[];
  selectedSessionId: string | null;
  turns: RuntimeTurnSummary[];
  onCreateSession: () => void;
  onRefresh: () => void;
  onSelectSession: (sessionId: string) => void;
}

export function RuntimeSurface(props: RuntimeSurfaceProps) {
  const selectedSession = props.sessions.find((session) => session.id === props.selectedSessionId);

  return (
    <div className="records-surface">
      <section className="record-form" aria-label="Runtime controls">
        <div className="surface-header-row">
          <div className="section-heading">
            <p className="eyebrow">Agent runtime</p>
            <h3>Sessions and turns</h3>
          </div>
          <button type="button" onClick={props.onCreateSession}>
            New session
          </button>
        </div>
        <div className="actions">
          <button className="secondary" type="button" onClick={props.onRefresh}>
            Refresh
          </button>
          {selectedSession === undefined ? null : (
            <button
              className="secondary"
              type="button"
              onClick={() => props.onSelectSession(selectedSession.id)}
            >
              Reload turns
            </button>
          )}
        </div>
        <p className="shell-note">
          Review what the agent understood, which tool it planned, and the response returned for
          each owner task.
        </p>
      </section>

      <section className="record-list" aria-label="Runtime sessions">
        <div className="section-heading">
          <p className="eyebrow">Sessions</p>
          <h3>Conversation runs</h3>
        </div>
        {props.sessions.length === 0 ? (
          <EmptyStateSurface
            title="No runtime sessions yet"
            body="Send an owner chat task or create a session to start tracking turns."
            onChat={props.onCreateSession}
            actionLabel="Create session"
          />
        ) : (
          props.sessions.map((session) => (
            <article className="record-row" key={session.id}>
              <div>
                <p className="eyebrow">{session.status}</p>
                <h4>{session.turnCount} turn runtime session</h4>
                <p>{new Date(session.createdAt).toLocaleString()}</p>
              </div>
              <button
                className={props.selectedSessionId === session.id ? "active" : ""}
                type="button"
                onClick={() => props.onSelectSession(session.id)}
              >
                View
              </button>
            </article>
          ))
        )}
      </section>

      <section className="record-list" aria-label="Runtime turns">
        <div className="section-heading">
          <p className="eyebrow">Turns</p>
          <h3>{selectedSession === undefined ? "Select a session" : "Runtime history"}</h3>
        </div>
        {selectedSession === undefined ? (
          <div className="empty-record">
            <h3>No session selected</h3>
            <p>Select a runtime session to inspect its turns.</p>
          </div>
        ) : props.turns.length === 0 ? (
          <div className="empty-record">
            <h3>No turns in this session</h3>
            <p>Use the chat composer to send a task through this runtime session.</p>
          </div>
        ) : (
          props.turns.map((turn) => (
            <article className="record-row runtime-turn-row" key={turn.id}>
              <div>
                <p className="eyebrow">{turn.status}</p>
                <h4>{turn.plan.toolName}</h4>
                <p>{turn.message}</p>
                <small>{turn.response}</small>
              </div>
              <span>{new Date(turn.createdAt).toLocaleTimeString()}</span>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
