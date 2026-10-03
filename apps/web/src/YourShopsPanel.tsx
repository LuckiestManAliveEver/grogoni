import { commerceAddressFromGrogoniId, type AccountShopSummary } from "@grogoni/shared-types";

import type { ActiveBusiness } from "./grogoni-application-shared";

export interface YourShopsPanelProps {
  shops: AccountShopSummary[];
  business: ActiveBusiness;
  onSwitchBusiness: (shop: AccountShopSummary) => void;
}

export function YourShopsPanel({ shops, business, onSwitchBusiness }: YourShopsPanelProps) {
  if (shops.length <= 1) return null;

  return (
    <section className="record-form" aria-label="Your shops">
      <div className="section-heading">
        <p className="eyebrow">Account</p>
        <h3>Your shops</h3>
      </div>
      <div className="connected-social-list" role="list">
        {shops.map((shop) => (
          <article className="connected-social-card" role="listitem" key={shop.business.id}>
            <div>
              <span>{commerceAddressFromGrogoniId(shop.business.grogoniId)}</span>
              <strong>{shop.business.name}</strong>
              <p>{shop.membership.role}</p>
            </div>
            {shop.business.id === business.id ? (
              <span className="shell-note">Current shop</span>
            ) : (
              <button type="button" onClick={() => onSwitchBusiness(shop)}>
                Switch to this shop
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
