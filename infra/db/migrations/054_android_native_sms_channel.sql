alter table conversation_messages
  drop constraint if exists conversation_messages_provider_check,
  add constraint conversation_messages_provider_check check (
    provider in (
      'grogoni', 'telegram', 'whatsapp', 'messenger', 'instagram', 'tiktok', 'x', 'sms',
      'native_sms'
    )
  ),
  drop constraint if exists conversation_messages_selected_channel_check,
  add constraint conversation_messages_selected_channel_check check (
    selected_channel in (
      'grogoni', 'sms', 'mms', 'rcs_business', 'whatsapp_business', 'telegram',
      'facebook_messenger', 'instagram_messaging', 'tiktok_business', 'x_dm', 'native_sms',
      'email'
    )
  ),
  drop constraint if exists conversation_messages_actual_channel_check,
  add constraint conversation_messages_actual_channel_check check (
    actual_channel is null or actual_channel in (
      'grogoni', 'sms', 'mms', 'rcs_business', 'whatsapp_business', 'telegram',
      'facebook_messenger', 'instagram_messaging', 'tiktok_business', 'x_dm', 'native_sms',
      'email'
    )
  );

create table if not exists native_sms_devices (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists native_sms_devices_account_device_unique_idx
  on native_sms_devices (account_id, (record ->> 'deviceId'))
  where account_id is not null and record ->> 'revokedAt' is null;

create index if not exists native_sms_devices_account_readiness_idx
  on native_sms_devices (account_id, (record ->> 'readiness'), updated_at desc)
  where account_id is not null;

create table if not exists native_sms_device_commands (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists native_sms_device_commands_message_unique_idx
  on native_sms_device_commands ((record ->> 'messageId'));

create index if not exists native_sms_device_commands_device_status_idx
  on native_sms_device_commands ((record ->> 'deviceId'), (record ->> 'status'), updated_at)
  where record ->> 'status' not in ('completed', 'failed', 'cancelled');

create index if not exists native_sms_device_commands_business_idx
  on native_sms_device_commands (business_id, updated_at desc)
  where business_id is not null;

comment on table native_sms_devices is
  'Authenticated Android execution nodes with explicitly reported SMS role, permission, and SIM readiness.';
comment on table native_sms_device_commands is
  'Single-device, replay-safe commands delegating canonical native SMS messages to Android.';
