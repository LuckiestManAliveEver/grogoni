import { type ShopPresenceStatus } from "./grogoni-application-shared";

export function ShopPresenceButtons({
  activeStatus,
  onStatusChange
}: {
  activeStatus: ShopPresenceStatus;
  onStatusChange: (status: ShopPresenceStatus) => void;
}) {
  const statuses: Array<{ id: ShopPresenceStatus; label: string }> = [
    { id: "online", label: "Online" },
    { id: "private", label: "Private" },
    { id: "offline", label: "Offline" }
  ];

  return (
    <span className="shop-presence-buttons" aria-label="Shop status">
      {statuses.map((status) => (
        <button
          aria-label={`${status.label} shop status`}
          className={`presence-dot ${status.id} ${activeStatus === status.id ? "active" : ""}`}
          key={status.id}
          type="button"
          title={`${status.label} across devices`}
          onClick={() => onStatusChange(status.id)}
        />
      ))}
    </span>
  );
}
