import type { QueryResult, QueryResultRow } from "pg";

/** One committed statement: a deletion failure must retain all native records for retry. */
export async function deleteNativeRuntimeScope(
  database: {
    query: <R extends QueryResultRow>(sql: string, values: unknown[]) => Promise<QueryResult<R>>;
  },
  actorIds: string[],
  businessIds: string[]
): Promise<number> {
  const result = await database.query<{ deleted_count: number }>(
    `with scoped_tasks as materialized (
       select business_id,task_id from business_environment_tasks
       where actor_id=any($1::text[]) or business_id=any($2::text[])
     ), deleted_verifications as (
       delete from business_environment_task_verifications
       where (business_id,task_id) in (select business_id,task_id from scoped_tasks) returning 1
     ), deleted_instances as (
       delete from business_environment_instances
       where (business_id,task_id) in (select business_id,task_id from scoped_tasks) returning 1
     ), deleted_steps as (
       delete from business_environment_task_steps
       where (business_id,task_id) in (select business_id,task_id from scoped_tasks)
         and (select count(*) from deleted_verifications)>=0 returning 1
     ), deleted_tasks as (
       delete from business_environment_tasks
       where (business_id,task_id) in (select business_id,task_id from scoped_tasks)
         and (select count(*) from deleted_steps)>=0
         and (select count(*) from deleted_instances)>=0 returning 1
     ), deleted_approvals as (
       delete from business_runtime_approvals
       where actor_id=any($1::text[]) or business_id=any($2::text[]) returning 1
     )
     select ((select count(*) from deleted_verifications)+(select count(*) from deleted_instances)
       +(select count(*) from deleted_steps)+(select count(*) from deleted_tasks)
       +(select count(*) from deleted_approvals))::int as deleted_count`,
    [actorIds, businessIds]
  );
  return result.rows[0]?.deleted_count ?? 0;
}
