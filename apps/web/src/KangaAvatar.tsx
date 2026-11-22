import { kangaIdentity, kangaStyle, shopInitials } from "./kanga-identity";
import "./design-d.css";

/**
 * A shop avatar framed by its kanga pattern (Design D). Decorative: the shop's name is always
 * shown as text beside it, so the avatar itself is hidden from assistive technology.
 */
export function KangaAvatar(props: { shopId: string; name: string; className: string }) {
  const identity = kangaIdentity(props.shopId);
  return (
    <span
      className={`${props.className} kanga-avatar kanga-${identity.motif}`}
      data-kanga-motif={identity.motif}
      style={kangaStyle(identity)}
      aria-hidden="true"
    >
      <b className="kanga-avatar-plate">{shopInitials(props.name)}</b>
    </span>
  );
}
