drop index if exists native_sms_device_commands_business_idx;
drop index if exists native_sms_device_commands_device_status_idx;
drop index if exists native_sms_device_commands_message_unique_idx;
drop table if exists native_sms_device_commands;

drop index if exists native_sms_devices_account_readiness_idx;
drop index if exists native_sms_devices_account_device_unique_idx;
drop table if exists native_sms_devices;

alter table conversation_messages
  drop constraint if exists conversation_messages_provider_check,
  add constraint conversation_messages_provider_check check (
    provider in ('grogoni', 'telegram', 'whatsapp', 'messenger', 'instagram', 'tiktok', 'x', 'sms')
  ),
  drop constraint if exists conversation_messages_selected_channel_check,
  add constraint conversation_messages_selected_channel_check check (
    selected_channel in (
      'grogoni', 'sms', 'mms', 'rcs_business', 'whatsapp_business', 'telegram',
      'facebook_messenger', 'instagram_messaging', 'tiktok_business', 'x_dm', 'email'
    )
  ),
  drop constraint if exists conversation_messages_actual_channel_check,
  add constraint conversation_messages_actual_channel_check check (
    actual_channel is null or actual_channel in (
      'grogoni', 'sms', 'mms', 'rcs_business', 'whatsapp_business', 'telegram',
      'facebook_messenger', 'instagram_messaging', 'tiktok_business', 'x_dm', 'email'
    )
  );
