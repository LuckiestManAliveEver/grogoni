import { sessionCookie, type Transaction } from "./session-routes.ts";

type RecordView = Record<string, unknown>;

export function createPublicRoutes(transaction: Transaction) {
  return async (request: Request, path: string): Promise<Response | null> => {
    if (
      request.method === "GET" &&
      (path === "/auth/oauth/providers" || path === "/api/auth/oauth/providers")
    )
      return Response.json({ providers: [] });
    if (request.method === "GET" && path === "/public/storefronts") {
      const url = new URL(request.url);
      const rawLimit = url.searchParams.get("limit") ?? "24";
      if (!/^\d+$/.test(rawLimit)) return Response.json({ code: "limit_invalid" }, { status: 400 });
      const limit = Math.min(50, Math.max(1, Number(rawLimit)));
      const search = (url.searchParams.get("search") ?? "").trim().toLowerCase().slice(0, 120);
      return transaction(async (client) => {
        const result = await client.query(
          `
          select b.record as business, p.record as presence,
            coalesce((select jsonb_agg(jsonb_build_object(
              'id', c.record->>'id', 'name', c.record->>'name', 'unit', c.record->>'unit',
              'available', true, 'sellingPrice', c.record->'sellingPrice', 'image', null))
              from cp2_products c where c.business_id = b.entity_id
              and (c.record->>'quantity')::numeric > 0), '[]'::jsonb) as products
          from cp2_businesses b left join cp2_shop_presences p on p.entity_id = b.entity_id
          where coalesce(p.record->>'status', 'online') <> 'private'
            and coalesce(b.record->>'quarantined', 'false') <> 'true'
            and ($1 = '' or position($1 in lower(b.record->>'name')) > 0
              or position($1 in lower(b.record->>'grogoniId')) > 0
              or exists (select 1 from cp2_products c where c.business_id = b.entity_id
                and position($1 in lower(c.record->>'name')) > 0))
          order by b.record->>'name' limit $2`,
          [search, limit]
        );
        return Response.json({
          storefronts: result.rows.map((row) => {
            const business = row.business as RecordView;
            const presence = row.presence as RecordView | null;
            return {
              agentId: business.grogoniId,
              grogoniId: business.grogoniId,
              commerceAddress: `${String(business.grogoniId)
                .trim()
                .toLowerCase()
                .replace(/^grogoni\./, "")}@grogoni.com`,
              businessName: business.name,
              presence: {
                status: presence?.status ?? "online",
                updatedAt: presence?.updatedAt ?? new Date(0).toISOString()
              },
              products: row.products
            };
          })
        });
      });
    }
    if (!(
      (request.method === "GET" && path === "/v1/marketplace-intro") ||
      (request.method === "POST" && path === "/v1/marketplace-intro/complete")
    ))
      return null;
    const sessionId = sessionCookie(request);
    if (!sessionId) return Response.json({ code: "auth_required" }, { status: 401 });
    const input = request.method === "POST" ? await request.json() : {};
    const businessId =
      request.method === "POST"
        ? (input.businessId ?? null)
        : new URL(request.url).searchParams.get("businessId");
    return transaction(async (client) => {
      const actor = (
        await client.query(
          `select account_id, user_id from sessions where id = $1
        and revoked_at is null and expires_at > now() and inactivity_expires_at > now()
        and absolute_expires_at > now()`,
          [sessionId]
        )
      ).rows[0];
      if (!actor) return Response.json({ code: "auth_required" }, { status: 401 });
      if (businessId !== null) {
        const member = await client.query(
          "select 1 from business_memberships where business_id = $1 and user_id = $2",
          [businessId, actor.user_id]
        );
        if (!member.rows.length)
          return Response.json({ code: "membership_required" }, { status: 403 });
      }
      const id = `${actor.account_id}:${businessId ?? "marketplace"}`;
      const previous = (
        await client.query("select record from cp2_marketplace_intro_states where entity_id = $1", [
          id
        ])
      ).rows[0]?.record as RecordView | undefined;
      const now = new Date().toISOString();
      const record = previous ?? {
        accountId: actor.account_id,
        userId: actor.user_id,
        businessId,
        completedAt: null,
        updatedAt: now
      };
      if (request.method === "POST") {
        record.completedAt ??= now;
        record.updatedAt = now;
        await client.query(
          `insert into cp2_marketplace_intro_states (entity_id, account_id, user_id, business_id, record)
          values ($1,$2,$3,$4,$5::jsonb) on conflict (entity_id) do update set record = excluded.record, updated_at = now()`,
          [id, actor.account_id, actor.user_id, businessId, JSON.stringify(record)]
        );
      }
      return Response.json(record);
    });
  };
}
