-- Offer provenance belongs to canonical invoices; no second transaction ledger.
alter table invoices add column offer_fulfillment jsonb not null default '[]'::jsonb;
alter table invoices add constraint invoice_offer_fulfillment_array check (jsonb_typeof(offer_fulfillment) = 'array');
