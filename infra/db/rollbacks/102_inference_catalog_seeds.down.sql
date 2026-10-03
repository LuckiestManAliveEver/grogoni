-- Reverses 102_inference_catalog_seeds.sql by removing the seeded catalog rows. Bindings that
-- already activated one of these models report the model as unavailable until the shop picks
-- another model, like any other catalog removal.
delete from cp2_model_catalog
where entity_id in (
  'smollm2-360m-device',
  'qwen2.5-0.5b-device',
  'qwen3-1.7b-device',
  'qwen3-4b-grogoni-cloud'
);
