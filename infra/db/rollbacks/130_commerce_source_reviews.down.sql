-- Back up metadata before rollback; review/authorization records require the newer application.
drop index if exists unified_commerce_candidate_version;
drop index if exists unified_commerce_representation_principal;
