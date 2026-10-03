alter table purchase_receipts
  drop constraint if exists purchase_receipts_total_nonnegative_check;

alter table payments
  drop constraint if exists payments_amount_positive_check;

alter table products
  drop constraint if exists products_quantity_nonnegative_check;

drop index if exists payments_business_invoice_idx;
drop index if exists sessions_account_expiry_idx;
drop index if exists receipt_line_items_receipt_idx;
drop table if exists receipt_line_items;
drop index if exists purchase_receipts_business_agent_date_idx;
drop index if exists purchase_receipts_business_supplier_date_idx;
drop table if exists purchase_receipts;
drop index if exists receipt_ocr_jobs_business_status_idx;
drop table if exists receipt_ocr_jobs;
drop index if exists supplier_contact_links_agent_unique_idx;
drop index if exists supplier_contact_links_supplier_unique_idx;
drop table if exists supplier_contact_links;
drop index if exists sales_agents_business_phone_idx;
drop index if exists sales_agents_business_supplier_idx;
drop table if exists sales_agents;
drop index if exists suppliers_business_updated_idx;
drop index if exists customers_business_contact_idx;
drop index if exists products_business_updated_idx;
drop index if exists products_business_sku_unique_idx;
drop index if exists businesses_grogoni_id_unique_idx;

alter table suppliers drop column if exists last_purchase_date;
alter table suppliers drop column if exists purchase_receipt_count;
alter table suppliers drop column if exists sales_agent_count;
alter table suppliers drop column if exists linked_phonebook_contact_name;
alter table suppliers drop column if exists linked_phonebook_contact_id;
alter table businesses drop column if exists grogoni_id;
