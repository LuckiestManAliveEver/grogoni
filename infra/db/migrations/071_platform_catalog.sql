-- Moves the model and built-in agent catalogs from hardcoded application arrays
-- (aiModelRegistry in services/api/src/cp2/domains/agent-runtime/model-catalog.ts,
-- defaultAgentDefinition in packages/shared-types/src/index.ts) to DB-hosted, operator-editable
-- rows. Every device already reads the effective catalog through the existing API (GET
-- /v1/ai-models and equivalent); this migration makes the API's answer come from these tables
-- instead of a value baked into the deployed build, so adding/editing/disabling a catalog entry no
-- longer requires a code change and redeploy. Inference continues to run through the existing API
-- backend exactly as before - this only changes where the list of available agents/models lives,
-- never how or where inference executes.

-- entity_id/business_id/account_id/user_id/parent_id/record/updated_at is the standard shape every
-- table in normalizedCollections (services/api/src/cp2/postgres-store.ts) must have: the generic
-- snapshot loader/writer reads and writes exactly these seven columns for every registered
-- collection, regardless of whether a given table actually needs the scoping columns. These three
-- tables are global (not shop-scoped), so business_id/account_id/user_id/parent_id stay null except
-- where noted below - not extra columns, but the fixed contract the generic persistence path
-- requires.
create table cp2_model_catalog (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_model_catalog_record_check check (
    jsonb_typeof(record) = 'object'
    and record ?& array['id', 'label', 'capabilities', 'available']
    and record ->> 'id' = entity_id
    and char_length(record ->> 'id') between 1 and 220
    and char_length(record ->> 'label') between 1 and 200
    and jsonb_typeof(record -> 'capabilities') = 'array'
    and jsonb_typeof(record -> 'available') = 'boolean'
  )
);

create table cp2_agent_catalog (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_agent_catalog_record_check check (
    jsonb_typeof(record) = 'object'
    and record ?& array['id', 'displayName', 'instructions', 'tools', 'skillIds']
    and record ->> 'id' = entity_id
    and char_length(record ->> 'id') between 1 and 220
    and char_length(record ->> 'displayName') between 1 and 200
    and char_length(record ->> 'instructions') between 1 and 20000
    and jsonb_typeof(record -> 'tools') = 'array'
    and jsonb_typeof(record -> 'skillIds') = 'array'
  )
);

-- A platform operator is a deployment operator (e.g. Julien), not a shop owner/staff role - every
-- existing authorization check in this codebase is scoped to a specific business (see
-- Cp2Store.requireAuthorizedSession), and catalog entries are global, not shop-scoped. Membership
-- in this table is the only source of that authority and is never grantable through any API route;
-- see services/api/scripts/grant-platform-operator.mjs, which is the only writer. entity_id and
-- account_id are both the granted account's id, so an operator grant is found through either the
-- generic entity_id lookup or an accountId-scoped query.
create table cp2_platform_operators (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_platform_operators_record_check check (
    jsonb_typeof(record) = 'object'
    and record ?& array['id', 'accountId', 'grantedAt', 'grantedBy']
    and entity_id = account_id
    and record ->> 'id' = entity_id
    and record ->> 'accountId' = account_id
    and (record ->> 'grantedAt')::timestamp with time zone is not null
    and char_length(record ->> 'grantedBy') between 1 and 220
  )
);

-- Seeds cp2_model_catalog with the exact current aiModelRegistry content (see
-- services/api/src/cp2/domains/agent-runtime/model-catalog.ts) so a deployment's catalog is
-- identical before and after this migration; going forward these rows, not the code array, are
-- authoritative. Provider-gated availability (the two openai-* entries) is computed at read time
-- from deployment env vars (computeModelAvailability) and combined with the stored flag - the
-- seeded `available: true` preserves today's behavior while still letting an operator disable one.
insert into cp2_model_catalog (entity_id, record, updated_at) values
  ('smollm2-360m-android', '{"id":"smollm2-360m-android","label":"SmolLM2 360M (Android saver)","provider":"local","description":"Smallest offline option for entry-level Android phones and short agent tasks.","capabilities":["chat","offline","english"],"available":true,"source":"huggingface","format":"GGUF","license":"Apache-2.0","licenseUrl":"https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct/blob/main/LICENSE","modelCardUrl":"https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF","downloadUrl":"https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF/resolve/main/smollm2-360m-instruct-q8_0.gguf?download=true","fileName":"smollm2-360m-instruct-q8_0.gguf","fileSizeBytes":386000000,"minimumMemoryGb":2,"recommended":false,"contextWindow":8192}'::jsonb, now()),
  ('tinyllama-1.1b-chat-q3-k-m-android', '{"id":"tinyllama-1.1b-chat-q3-k-m-android","label":"TinyLlama 1.1B Q3_K_M (Android saver)","provider":"local","description":"Compact Apache-2.0 Llama-architecture chat model for Android devices with limited storage.","capabilities":["chat","offline","english","llama.cpp"],"available":true,"source":"huggingface","format":"GGUF","license":"Apache-2.0","licenseUrl":"https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/blob/main/README.md","modelCardUrl":"https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF","downloadUrl":"https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q3_K_M.gguf?download=true","fileName":"tinyllama-1.1b-chat-v1.0.Q3_K_M.gguf","fileSizeBytes":551000000,"minimumMemoryGb":3,"recommended":false,"contextWindow":2048}'::jsonb, now()),
  ('tinyllama-1.1b-chat-q4-k-m-android', '{"id":"tinyllama-1.1b-chat-q4-k-m-android","label":"TinyLlama 1.1B Q4_K_M (Android balanced)","provider":"local","description":"Recommended Apache-2.0 TinyLlama chat quantization for capable mainstream Android phones.","capabilities":["chat","offline","english","llama.cpp","instruction-following"],"available":true,"source":"huggingface","format":"GGUF","license":"Apache-2.0","licenseUrl":"https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/blob/main/README.md","modelCardUrl":"https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF","downloadUrl":"https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf?download=true","fileName":"tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf","fileSizeBytes":669000000,"minimumMemoryGb":4,"recommended":true,"contextWindow":2048}'::jsonb, now()),
  ('qwen2.5-0.5b-android', '{"id":"qwen2.5-0.5b-android","label":"Qwen2.5 0.5B (Android recommended)","provider":"local","description":"Balanced multilingual on-device agent model for mainstream Android phones.","capabilities":["chat","tool-routing","offline","multilingual"],"available":true,"source":"huggingface","format":"GGUF","license":"Apache-2.0","licenseUrl":"https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/main/LICENSE","modelCardUrl":"https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF","downloadUrl":"https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf?download=true","fileName":"qwen2.5-0.5b-instruct-q4_k_m.gguf","fileSizeBytes":491000000,"minimumMemoryGb":3,"recommended":true,"contextWindow":32768}'::jsonb, now()),
  ('qwen2.5-1.5b-android', '{"id":"qwen2.5-1.5b-android","label":"Qwen2.5 1.5B (high-end Android)","provider":"local","description":"More capable multilingual local model for phones with at least 6 GB RAM.","capabilities":["chat","reasoning","tool-routing","offline","multilingual"],"available":true,"source":"huggingface","format":"GGUF","license":"Apache-2.0","licenseUrl":"https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/main/LICENSE","modelCardUrl":"https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF","downloadUrl":"https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf?download=true","fileName":"qwen2.5-1.5b-instruct-q4_k_m.gguf","fileSizeBytes":1120000000,"minimumMemoryGb":6,"recommended":false,"contextWindow":32768}'::jsonb, now()),
  ('grogoniclaw-local', '{"id":"grogoniclaw-local","label":"Grogoni deterministic compatibility fallback","provider":"local","description":"Built-in deterministic agent behavior for compatibility; not a general-purpose language model.","capabilities":["tool-routing","offline"],"available":true,"source":"builtin","format":"remote","license":null,"licenseUrl":null,"modelCardUrl":null,"downloadUrl":null,"fileName":null,"fileSizeBytes":null,"minimumMemoryGb":null,"recommended":false,"contextWindow":null}'::jsonb, now()),
  ('llama-cpp-configured', '{"id":"llama-cpp-configured","label":"Installed app llama.cpp bridge","provider":"local","description":"Optional native model runtime exposed by a supported installed Grogoni application.","capabilities":["chat","tool-routing","llama.cpp","native-bridge"],"available":false,"source":"builtin","format":"remote","license":null,"licenseUrl":null,"modelCardUrl":null,"downloadUrl":null,"fileName":null,"fileSizeBytes":null,"minimumMemoryGb":null,"recommended":false,"contextWindow":null}'::jsonb, now()),
  ('openai-fast', '{"id":"openai-fast","label":"OpenAI fast","provider":"openai","description":"Fast hosted reasoning for connected shops.","capabilities":["chat","tool-routing"],"available":true,"source":"hosted","format":"remote","license":null,"licenseUrl":null,"modelCardUrl":null,"downloadUrl":null,"fileName":null,"fileSizeBytes":null,"minimumMemoryGb":null,"recommended":false,"contextWindow":32000}'::jsonb, now()),
  ('openai-reasoning', '{"id":"openai-reasoning","label":"OpenAI reasoning","provider":"openai","description":"Higher-reasoning hosted profile for complex business tasks.","capabilities":["chat","reasoning","tool-routing"],"available":true,"source":"hosted","format":"remote","license":null,"licenseUrl":null,"modelCardUrl":null,"downloadUrl":null,"fileName":null,"fileSizeBytes":null,"minimumMemoryGb":null,"recommended":false,"contextWindow":32000}'::jsonb, now())
on conflict (entity_id) do nothing;

-- Seeds cp2_agent_catalog with the exact current defaultAgentDefinition (see
-- packages/shared-types/src/index.ts) as the sole built-in fallback template.
insert into cp2_agent_catalog (entity_id, record, updated_at) values
  ('builtin:shopkeeper', '{"id":"builtin:shopkeeper","displayName":"Shopkeeper","role":"General shopkeeper and storefront attendant","description":"Safe offline fallback while the open-source agent catalogue is unavailable.","operatingPattern":"Focused operator","workloadClass":"focused","minimumDeviceTier":"low","minimumMemoryGb":2,"recommendedContextTokens":1024,"personality":"Warm, concise, accurate and commercially practical","instructions":"Handle one clear shop task at a time, use saved business records, and ask before risky changes. When a workspace file should be given to the user, call workspace.deliver and refer to the delivered attachment without exposing its filesystem path.","knowledge":"Use saved products, customers, invoices, payments, receipts and shop policies.","tools":["Products","Customers","Suppliers","Invoices","Payments","Receipts","Reports","Notifications","Logistics","Workspace delivery"],"skillIds":[]}'::jsonb, now())
on conflict (entity_id) do nothing;
