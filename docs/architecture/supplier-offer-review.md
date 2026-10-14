# Confirmed Supplier Offers

Supplier management, including its generated chat surface, now exposes owner-entered offers.
The form uses the existing canonical hashtag parser and `/runtime/turns` endpoint for
`procurement.quote.record`; it does not dispatch a capability or write business records directly.

Prices are converted from decimal KES to exact integer minor units. Quantities use exact
thousandths of the selected product's canonical unit. Exponents, negative values, excess
precision, unsafe integers, missing charges and invalid expiry/lead times are rejected.
The proposed action must match every reviewed argument before confirmation is exposed.
Fields remain locked until a confirmed or rejected decision is acknowledged. Rejection uses
the original runtime session and the existing durable approval gate. Offers are unavailable offline.

Successful recording is displayed only after a fresh authenticated native read returns the same
immutable quote identity and values. A timeout or missing committed record remains an error,
not success. Quote records represent owner-entered supplier information, not supplier
acknowledgement, submitted purchase orders or delivery. Expired offers remain reviewable but
are excluded by the procurement planner's eligibility rules.

Native reads enforce current supplier/product access, scope all joins to the authenticated
business and bound responses to the latest 200 offers with an explicit truncation indicator.
Malformed client responses fail closed without crashing the surrounding supplier/receipt UI.

Validation covers exact conversions, argument substitution, locked review, durable rejection,
read-after-write verification, real canonical hashtag HTTP confirmation against PostgreSQL,
anonymous read denial, receipt recovery, and Chrome accessibility/layout checks at 320px and
1440px. Synthetic fixtures do not claim live supplier acknowledgement or model performance.
