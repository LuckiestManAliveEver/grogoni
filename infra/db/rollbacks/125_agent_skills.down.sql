-- Export packages before rollback; this removes the registry only, never business records.
drop table if exists cp2_agent_skills;
