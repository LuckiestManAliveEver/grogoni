import { useEffect, useState, type FormEvent } from "react";
import { shopPlaceMaxLength, type ShopPresenceSummary } from "@grogoni/shared-types";

import { getJson, patchJson } from "./api-helpers";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { shopCategories, shopCategoryLabels, type ShopCategory } from "./shop-directory";
import { getUserFacingErrorMessage } from "./user-facing-error";

/**
 * The owner's shop directory listing: what the shop sells and where it is, so buyers can find it
 * by category and place. Self-contained like CatalogueShareSettingsCard.
 */
export default function ShopDirectoryListingCard(props: { businessId: string }) {
  const presencePath = `/businesses/${props.businessId}/presence`;
  const { isPending, runAction } = useAsyncActions();
  const [loaded, setLoaded] = useState(false);
  const [category, setCategory] = useState<ShopCategory | "">("");
  const [place, setPlace] = useState("");
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void getJson<ShopPresenceSummary>(presencePath)
      .then((presence) => {
        if (cancelled) return;
        setCategory(presence.category ?? "");
        setPlace(presence.place ?? "");
        setLoaded(true);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [presencePath, attempt]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    void runAction("shop-directory-save", async () => {
      try {
        const saved = await patchJson<ShopPresenceSummary>(
          `/businesses/${props.businessId}/directory-listing`,
          { category: category === "" ? null : category, place: place.trim() || null }
        );
        setCategory(saved.category ?? "");
        setPlace(saved.place ?? "");
        setMessage(
          saved.category || saved.place
            ? "Saved. Buyers can now find your shop by what it sells and where it is."
            : "Saved. Your shop is listed by name only."
        );
      } catch (error) {
        setMessage(getUserFacingErrorMessage(error));
      }
    });
  };

  return (
    <section className="record-form shop-directory-listing-card" aria-label="Shop directory">
      <div className="section-heading">
        <p className="eyebrow">Shop directory</p>
        <h3>Help buyers find your shop</h3>
      </div>
      {!loaded ? (
        message.length > 0 ? (
          <>
            <p className="shell-note">{message}</p>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setMessage("");
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </button>
          </>
        ) : (
          <p>Loading…</p>
        )
      ) : (
        <form onSubmit={save}>
          <p className="shell-note">
            Buyers searching the marketplace can filter by what a shop sells and where it is. A
            private shop is never listed.
          </p>
          <label>
            What you sell
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as ShopCategory | "")}
            >
              <option value="">Not set</option>
              {shopCategories.map((value) => (
                <option key={value} value={value}>
                  {shopCategoryLabels[value]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Where you are
            <input
              value={place}
              maxLength={shopPlaceMaxLength}
              placeholder="For example Westlands, Nairobi"
              onChange={(event) => setPlace(event.target.value)}
            />
          </label>
          <button type="submit" disabled={isPending("shop-directory-save")}>
            Save listing
          </button>
          {message.length > 0 ? (
            <p className="shell-note" role="status">
              {message}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}
