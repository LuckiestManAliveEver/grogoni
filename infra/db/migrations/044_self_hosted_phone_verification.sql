-- Grogoni owns OTP creation and verification. Gateways only deliver message bodies.

alter table otp_challenges add column if not exists consumed_at timestamptz;
alter table otp_challenges add column if not exists resend_count integer not null default 0;
alter table otp_challenges add column if not exists next_resend_at timestamptz;
alter table otp_challenges add column if not exists provider text;
alter table otp_challenges add column if not exists provider_message_id text;
alter table otp_challenges drop constraint if exists otp_challenges_resend_count_check;
alter table otp_challenges add constraint otp_challenges_resend_count_check
  check (resend_count between 0 and 3);

alter table verification_challenges add column if not exists consumed_at timestamptz;
alter table verification_challenges add column if not exists resend_count integer not null default 0;
alter table verification_challenges add column if not exists next_resend_at timestamptz;
alter table verification_challenges add column if not exists provider text;
alter table verification_challenges add column if not exists provider_message_id text;
alter table verification_challenges add column if not exists identifier_hash text;
alter table verification_challenges drop constraint if exists verification_challenges_status_check;
alter table verification_challenges add constraint verification_challenges_status_check
  check (status in ('pending', 'verified', 'expired', 'locked', 'invalidated'));
alter table verification_challenges drop constraint if exists verification_challenges_resend_count_check;
alter table verification_challenges add constraint verification_challenges_resend_count_check
  check (resend_count between 0 and 3);

create unique index if not exists verification_challenges_one_active_phone_idx
  on verification_challenges(destination, purpose)
  where channel = 'phone' and verified_at is null and consumed_at is null;

create table if not exists sms_delivery_attempts (
  id uuid primary key,
  challenge_id uuid not null references verification_challenges(id) on delete cascade,
  provider text not null check (btrim(provider) <> ''),
  provider_message_id text,
  status text not null check (status in ('accepted', 'delivered', 'failed', 'rejected', 'unknown')),
  error_code text,
  attempt_number integer not null check (attempt_number > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint sms_delivery_attempts_challenge_number_unique unique(challenge_id, attempt_number)
);
create index if not exists sms_delivery_attempts_provider_message_idx
  on sms_delivery_attempts(provider, provider_message_id)
  where provider_message_id is not null;

create table if not exists cp2_sms_delivery_attempts (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists cp2_sms_delivery_attempts_parent_idx
  on cp2_sms_delivery_attempts(parent_id)
  where parent_id is not null;

comment on table sms_delivery_attempts is
  'Delivery-only SMS gateway attempts; verification codes are never stored here.';
