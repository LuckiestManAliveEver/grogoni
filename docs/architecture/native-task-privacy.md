# Native task privacy cleanup

The existing account-deletion maintenance port now deletes native approvals,
task specifications, step observations, verification reports and environment
instances in one independently committed PostgreSQL statement. Foreign-key order
is explicit. A failure rolls back every native deletion and stops account
anonymization through the existing partial-failure/retry path.

Scope remains the account's actor IDs plus exclusively owned businesses. Shared
business records created by other actors are retained unless that business is
itself in the deletion scope. An empty scope deletes nothing. No new deletion
queue or snapshot store is introduced. Existing Node and Edge maintenance wiring
uses the same implementation; the maintenance-only port still cannot issue or
claim approval tokens.

This closes account-deletion coverage for the native task tables introduced so
far. Configurable ordinary task retention, procurement records introduced later,
production task execution and the remaining implementation phases still need
their own integration and validation.
