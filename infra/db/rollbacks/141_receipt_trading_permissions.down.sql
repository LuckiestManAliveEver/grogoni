-- Preserve issued/revoked permissions as evidence. Earlier code ignores this metadata kind.
drop index if exists unified_commerce_active_trading_permission;
alter table cp2_unified_commerce_records drop constraint if exists unified_commerce_trading_permission_valid;
-- Keep the expanded allowlist while retained trading_grant records exist.
