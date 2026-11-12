-- Refuse rollback while linked-device messages exist. Disable the connector first.
-- Archive/remove those messages explicitly before narrowing the constraints; never delete them here.
alter table conversation_messages
  drop constraint if exists conversation_messages_provider_check,
  add constraint conversation_messages_provider_check check (provider in ('grogoni', 'telegram', 'whatsapp', 'messenger', 'instagram', 'tiktok', 'x', 'sms', 'native_sms', 'email')),
  drop constraint if exists conversation_messages_selected_channel_check,
  add constraint conversation_messages_selected_channel_check check (selected_channel in ('grogoni', 'sms', 'mms', 'rcs_business', 'whatsapp_business', 'telegram', 'facebook_messenger', 'instagram_messaging', 'tiktok_business', 'x_dm', 'native_sms', 'email')),
  drop constraint if exists conversation_messages_actual_channel_check,
  add constraint conversation_messages_actual_channel_check check (actual_channel is null or actual_channel in ('grogoni', 'sms', 'mms', 'rcs_business', 'whatsapp_business', 'telegram', 'facebook_messenger', 'instagram_messaging', 'tiktok_business', 'x_dm', 'native_sms', 'email'));
