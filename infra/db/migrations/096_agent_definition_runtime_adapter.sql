-- AgentDefinition gains runtimeAdapterId (see ADR-collapse-harness-into-agent.md): which
-- registered AgentRuntimeAdapter runs an agent's turns is now fixed per agent definition instead
-- of an independently swappable "harness" dimension. Backfills the existing builtin:shopkeeper
-- row with its established default ("grogoni" - see legacyAgentRuntimeAdapterId), adds a second
-- built-in definition running on the Pi engine so it stays choosable, and requires the field on
-- every future row.

update cp2_agent_catalog
set record = record || jsonb_build_object('runtimeAdapterId', 'grogoni'),
  updated_at = now()
where entity_id = 'builtin:shopkeeper'
  and not (record ? 'runtimeAdapterId');

insert into cp2_agent_catalog (entity_id, record, updated_at) values
  ('builtin:pi-assistant', '{"id":"builtin:pi-assistant","displayName":"Shopkeeper (Pi engine)","role":"General shopkeeper and storefront attendant","description":"Same shopkeeper behavior, running on the Pi agent-loop engine.","operatingPattern":"Focused operator","workloadClass":"focused","minimumDeviceTier":"low","minimumMemoryGb":2,"recommendedContextTokens":1024,"personality":"Warm, concise, accurate and commercially practical","instructions":"Handle one clear shop task at a time, use saved business records, and ask before risky changes. When a workspace file should be given to the user, call workspace.deliver and refer to the delivered attachment without exposing its filesystem path.","knowledge":"Use saved products, customers, invoices, payments, receipts and shop policies.","tools":["Products","Customers","Suppliers","Invoices","Payments","Receipts","Reports","Notifications","Logistics","Workspace delivery"],"skillIds":[],"runtimeAdapterId":"pi"}'::jsonb, now())
on conflict (entity_id) do update
set record = excluded.record, updated_at = excluded.updated_at;

alter table cp2_agent_catalog
  drop constraint cp2_agent_catalog_record_check;

alter table cp2_agent_catalog
  add constraint cp2_agent_catalog_record_check check (
    jsonb_typeof(record) = 'object'
    and record ?& array['id', 'displayName', 'instructions', 'tools', 'skillIds', 'runtimeAdapterId']
    and record ->> 'id' = entity_id
    and char_length(record ->> 'id') between 1 and 220
    and char_length(record ->> 'displayName') between 1 and 200
    and char_length(record ->> 'instructions') between 1 and 20000
    and jsonb_typeof(record -> 'tools') = 'array'
    and jsonb_typeof(record -> 'skillIds') = 'array'
    and char_length(record ->> 'runtimeAdapterId') between 1 and 80
  );
