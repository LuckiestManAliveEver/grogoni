import { useEffect, useState } from "react";
import type { ShopPresenceSummary } from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { getJson, patchJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";

// Self-contained generated-surface card (Phase 4a pattern, see ProductManagementCard) - fetches
// its own shop presence from businessId alone rather than threading a toggle through
// ShopPresenceButtons' existing prop chain in ChatSurface.tsx/GrogoniApplication.tsx.
export default function CatalogueShareSettingsCard(props: { businessId: string }) {
  const presencePath = `/businesses/${props.businessId}/presence`;
  const { isPending, runAction } = useAsyncActions();
  const [presence, setPresence] = useState<ShopPresenceSummary | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void getJson<ShopPresenceSummary>(presencePath)
      .then((loaded) => {
        if (!cancelled) setPresence(loaded);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [presencePath]);

  async function toggleShareable(nextValue: boolean) {
    if (presence === null) return;
    const updated = await patchJson<ShopPresenceSummary>(presencePath, {
      status: presence.status,
      catalogueShareable: nextValue
    });
    setPresence(updated);
    setMessage(
      nextValue
        ? "Other shops can now browse and duplicate your catalogue."
        : "Your catalogue is no longer shareable."
    );
  }

  if (presence === null) {
    return (
      <section className="record-form catalogue-share-settings-card" aria-label="Catalogue sharing">
        {message.length > 0 ? <p className="shell-note">{message}</p> : <p>Loading…</p>}
      </section>
    );
  }

  return (
    <section className="record-form catalogue-share-settings-card" aria-label="Catalogue sharing">
      <div className="section-heading">
        <p className="eyebrow">Catalogue sharing</p>
        <h3>Let other shops duplicate your catalogue</h3>
      </div>
      <p className="shell-note">
        When enabled, other Grogoni shop owners can browse your product names, units, and selling
        prices while adding products, and copy them into their own catalogue as a starting point.
        Your buying prices, SKUs, and stock levels are never shared.
      </p>
      <label className="toggle-field">
        <input
          type="checkbox"
          checked={presence.catalogueShareable}
          disabled={isPending("catalogue-share-toggle")}
          onChange={(event) =>
            void runAction("catalogue-share-toggle", async () => {
              try {
                await toggleShareable(event.target.checked);
              } catch (error) {
                setMessage(getUserFacingErrorMessage(error));
              }
            })
          }
        />
        Allow other shops to duplicate my catalogue
      </label>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
    </section>
  );
}
