-- Credentials live only in the encrypted connector volume, never canonical message records.
alter table conversation_messages
  drop constraint if exists conversation_messages_provider_check,
  add constraint conversation_messages_provider_check check (provider in ('grogoni', 'telegram', 'whatsapp', 'messenger', 'instagram', 'tiktok', 'x', 'sms', 'native_sms', 'email', 'whatsapp_linked')),
  drop constraint if exists conversation_messages_selected_channel_check,
  add constraint conversation_messages_selected_channel_check check (selected_channel in ('grogoni', 'sms', 'mms', 'rcs_business', 'whatsapp_business', 'telegram', 'facebook_messenger', 'instagram_messaging', 'tiktok_business', 'x_dm', 'native_sms', 'email', 'whatsapp_linked')),
  drop constraint if exists conversation_messages_actual_channel_check,
  add constraint conversation_messages_actual_channel_check check (actual_channel is null or actual_channel in ('grogoni', 'sms', 'mms', 'rcs_business', 'whatsapp_business', 'telegram', 'facebook_messenger', 'instagram_messaging', 'tiktok_business', 'x_dm', 'native_sms', 'email', 'whatsapp_linked'));
