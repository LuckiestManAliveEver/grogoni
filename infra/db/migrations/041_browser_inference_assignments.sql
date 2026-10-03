create table if not exists cp2_browser_inference_assignments (
  entity_id text primary key,
  business_id text not null,
  account_id text not null,
  user_id text not null,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_browser_inference_assignments_identity_check
    check (
      record ? 'deviceId'
      and char_length(record ->> 'deviceId') between 1 and 180
      and record ? 'businessId'
      and record ->> 'businessId' = business_id
      and record ? 'accountId'
      and record ->> 'accountId' = account_id
      and record ? 'userId'
      and record ->> 'userId' = user_id
    ),
  constraint cp2_browser_inference_assignments_enabled_check
    check (
      record ? 'enabled'
      and jsonb_typeof(record -> 'enabled') = 'boolean'
    ),
  constraint cp2_browser_inference_assignments_readiness_check
    check (
      record ? 'readinessStatus'
      and record ->> 'readinessStatus' in ('ATTACHED', 'LOADING', 'READY', 'FAILED')
      and (
        record ->> 'readinessStatus' <> 'READY'
        or (
          record ->> 'enabled' = 'true'
          and record ->> 'lastSuccessfulInferenceAt' is not null
        )
      )
    ),
  constraint cp2_browser_inference_assignments_model_contract_check
    check (
      (
        record ->> 'selectedModelId' is null
        and record ->> 'modelFamilyId' is null
        and record ->> 'modelRevision' is null
        and (
          record -> 'runtimeContract' is null
          or record -> 'runtimeContract' = 'null'::jsonb
        )
        and (
          record -> 'checkpointCompatibilityContract' is null
          or record -> 'checkpointCompatibilityContract' = 'null'::jsonb
        )
      )
      or (
        char_length(record ->> 'selectedModelId') between 1 and 180
        and char_length(record ->> 'modelFamilyId') between 1 and 180
        and char_length(record ->> 'modelRevision') between 1 and 180
        and jsonb_typeof(record -> 'runtimeContract') = 'object'
        and jsonb_typeof(record -> 'checkpointCompatibilityContract') = 'object'
      )
    ),
  constraint cp2_browser_inference_assignments_contract_check
    check (
      record -> 'runtimeContract' is null
      or record -> 'runtimeContract' = 'null'::jsonb
      or (
        record #>> '{runtimeContract,schemaVersion}' = '1'
        and record #>> '{runtimeContract,adapterId}' in ('transformers-js', 'webllm')
        and char_length(record #>> '{runtimeContract,adapterVersion}') between 1 and 80
        and record #>> '{runtimeContract,runtime}' in ('browser-webgpu', 'browser-wasm')
        and record #>> '{runtimeContract,backend}' in ('webgpu', 'wasm')
        and (
          (record #>> '{runtimeContract,runtime}' = 'browser-webgpu'
            and record #>> '{runtimeContract,backend}' = 'webgpu')
          or
          (record #>> '{runtimeContract,runtime}' = 'browser-wasm'
            and record #>> '{runtimeContract,backend}' = 'wasm')
        )
        and record #>> '{runtimeContract,streaming}' = 'true'
        and record #>> '{runtimeContract,cancellation}' = 'true'
        and record #>> '{runtimeContract,tokenCounting}' in ('exact', 'estimated')
        and record #> '{runtimeContract,checkpointKinds}' = '["task-state"]'::jsonb
        and record #> '{runtimeContract,nativeStateFormat}' = 'null'::jsonb
        and (
          record #>> '{runtimeContract,adapterId}' <> 'webllm'
          or (
            record #>> '{runtimeContract,backend}' = 'webgpu'
            and char_length(record #>> '{runtimeContract,libraryRevision}') between 1 and 180
          )
        )
      )
    ),
  constraint cp2_browser_inference_assignments_checkpoint_check
    check (
      record -> 'checkpointCompatibilityContract' is null
      or record -> 'checkpointCompatibilityContract' = 'null'::jsonb
      or (
        record #>> '{checkpointCompatibilityContract,schemaVersion}' = '1'
        and record #>> '{checkpointCompatibilityContract,checkpointKind}' = 'task-state'
        and record #>> '{checkpointCompatibilityContract,taskStateSchema}'
          = 'grogoni.browser-task-state.v2'
        and record #>> '{checkpointCompatibilityContract,sourceAdapterId}'
          in ('transformers-js', 'webllm')
        and record #>> '{checkpointCompatibilityContract,promptRepresentation}'
          = 'role-content-messages'
        and record #>> '{checkpointCompatibilityContract,portableAcrossAdapters}' = 'true'
        and record #>> '{checkpointCompatibilityContract,sourceModelId}'
          = record ->> 'selectedModelId'
        and record #>> '{checkpointCompatibilityContract,modelFamilyId}'
          = record ->> 'modelFamilyId'
        and record #>> '{checkpointCompatibilityContract,sourceModelRevision}'
          = record ->> 'modelRevision'
        and record #>> '{checkpointCompatibilityContract,sourceAdapterId}'
          = record #>> '{runtimeContract,adapterId}'
      )
    )
);

create unique index if not exists cp2_browser_inference_assignments_device_idx
  on cp2_browser_inference_assignments (business_id, (record ->> 'deviceId'));

create index if not exists cp2_browser_inference_assignments_owner_idx
  on cp2_browser_inference_assignments (account_id, user_id);

create index if not exists cp2_browser_inference_assignments_model_idx
  on cp2_browser_inference_assignments ((record ->> 'selectedModelId'))
  where record ->> 'selectedModelId' is not null;
