import { describe, expect, it } from "vitest";
import { deliveringRead } from "../services/api/src/cp2/edge-snapshot-scope";

// The Edge scope loads a shop's memberships for a customer only on reads that mark messages
// delivered (tests/edge-delivered-postgres.test.ts proves the effect on PostgreSQL). Any other
// path must keep the narrower scope: a customer has no business seeing a shop's staff list.
describe("Edge reads that deliver messages", () => {
  it.each(["/v1/sync/changes", "/v1/conversations", "/v1/conversations/c-123"])(
    "%s loads the shop memberships delivery needs",
    (path) => expect(deliveringRead(path)).toBe(true)
  );

  it.each([
    "/v1/conversations/recycle-bin",
    "/v1/conversations/c-123/attachments/a-1/download",
    "/v1/conversations/c-123/typing",
    "/v1/conversations/c-123/messages/m-1",
    "/v1/conversationsX",
    "/businesses/b-1/customers",
    "/network"
  ])("%s does not", (path) => expect(deliveringRead(path)).toBe(false));
});
