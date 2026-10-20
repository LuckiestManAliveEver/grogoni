import { lazy, Suspense, useState } from "react";
import { StackedModule } from "./StackedModule";
import {
  externalMessagingApps,
  openExternalMessagingApp,
  type ExternalMessagingApp
} from "./messaging/external-app-handoff";

const MessagingConnectionsPanel = lazy(() => import("./MessagingConnectionsPanel"));

export function ExternalMessagingAppPicker(props: {
  open: boolean;
  businessId?: string;
  text: string;
  onClose: () => void;
  onSystemShare: () => void;
}) {
  const [notice, setNotice] = useState("");
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  async function openApp(id: ExternalMessagingApp, label: string) {
    const result = await openExternalMessagingApp(id, props.text);
    setNotice(
      result.copied
        ? `Message copied. Open ${label}, choose the recipient, paste, and send there.`
        : `Copy the draft below, then choose the recipient and send in ${label}.`
    );
  }
  return (
    <StackedModule
      open={props.open}
      moduleId="composer-external-app-picker"
      title="Share to apps"
      onClose={props.onClose}
    >
      <p>Choose an app, then review the recipient and send there. Delivery stays with that app.</p>
      <div className="composer-action-grid">
        {externalMessagingApps.map((app) => (
          <button key={app.id} type="button" onClick={() => void openApp(app.id, app.label)}>
            Open {app.label}
          </button>
        ))}
        <button type="button" onClick={props.onSystemShare}>
          Device share sheet
        </button>
      </div>
      <label>
        Message to share
        <textarea readOnly value={props.text} onFocus={(event) => event.currentTarget.select()} />
      </label>
      {notice ? <p role="status">{notice}</p> : null}
      {props.businessId ? (
        <button type="button" onClick={() => setConnectionsOpen((open) => !open)}>
          Business messaging connections
        </button>
      ) : null}
      {connectionsOpen && props.businessId ? (
        <Suspense fallback={<p>Opening connections…</p>}>
          <MessagingConnectionsPanel key={props.businessId} businessId={props.businessId} />
        </Suspense>
      ) : null}
    </StackedModule>
  );
}
