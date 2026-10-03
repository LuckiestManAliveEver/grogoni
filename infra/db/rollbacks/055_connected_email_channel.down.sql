drop table if exists connected_mailbox_oauth_sessions;
drop table if exists connected_mailboxes;

drop index if exists conversation_messages_email_thread_idx;

alter table conversation_messages
  drop column if exists bcc_addresses,
  drop column if exists cc_addresses,
  drop column if exists recipient_addresses,
  drop column if exists sender_address,
  drop column if exists external_thread_id,
  drop column if exists subject,
  drop constraint if exists conversation_messages_provider_check,
  add constraint conversation_messages_provider_check check (
    provider in (
      'grogoni', 'telegram', 'whatsapp', 'messenger', 'instagram', 'tiktok', 'x', 'sms',
      'native_sms'
    )
  );
