-- Back up source-order snapshots before dropping this column.
alter table invoices drop column if exists offer_fulfillment;
