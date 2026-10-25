import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateSkill,
  discoverSkills,
  safeResourcePath
} from "../services/api/src/cp2/domains/agent-skills/format.js";
import {
  AgentSkillsDomain,
  type SkillRequest
} from "../services/api/src/cp2/domains/agent-skills/store.js";

export const packageFiles = (
  body = "Use products.list to check authoritative stock. Never promise unavailable stock."
) => ({
  "SKILL.md": `---\nname: inventory-check\ndescription: Check inventory when asked about stock.\nlicense: MIT\nallowed-tools: products.list\n---\n${body}`
});
const owner = { sessionId: "owner", businessId: "business-a" };
function fixture() {
  const audit: unknown[] = [];
  const domain = new AgentSkillsDomain({
    authorize: (input: SkillRequest) => {
      if (!input.sessionId) throw new Error("unauthorized");
      if (input.sessionId === "other" && input.businessId === "business-a")
        throw new Error("cross-tenant");
      return {
        userId: input.sessionId,
        accountId: `account-${input.sessionId}`,
        role: input.sessionId === "staff" ? "staff" : "owner",
        operator: input.sessionId === "operator"
      };
    },
    generate: async () => packageFiles(),
    audit: (...args) => {
      audit.push(args);
    },
    agentAllowed: (_b, a) => a === "shopkeeper"
  });
  return { domain, audit };
}
function enable(domain: AgentSkillsDomain, input = owner) {
  const draft = domain.draft(input, { files: packageFiles(), grants: ["products.list"] });
  const digest = draft.versions[0]!.package.digest;
  domain.transition(input, draft.id, "install", draft.reviewDigest);
  domain.transition(input, draft.id, "enable");
  return { draft, digest };
}
describe("portable Agent Skills format", () => {
  it("validates standard metadata and does not include instructions in discovery metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "grogoni-skills-"));
    try {
      await mkdir(path.join(root, "inventory-check"));
      await writeFile(path.join(root, "inventory-check", "SKILL.md"), packageFiles()["SKILL.md"]);
      const result = await discoverSkills([root]);
      expect(result.diagnostics).toEqual([]);
      expect(result.metadata).toHaveLength(1);
      expect(JSON.stringify(result.metadata)).not.toContain("authoritative stock");
      expect(result.skills[0]!.body).toContain("authoritative stock");
      await mkdir(path.join(root, "missing"));
      expect((await discoverSkills([root])).diagnostics.join()).toContain(
        "Missing required SKILL.md"
      );
      expect((await discoverSkills([root, root])).diagnostics.join()).toContain(
        "Duplicate skill name"
      );
      await symlink("/etc/passwd", path.join(root, "inventory-check", "leak"));
      expect((await discoverSkills([root])).diagnostics.join()).toContain("regular files");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(["../private", "/private", "a/../../b", "a\\b", "%2e%2e/private", "a//b"])(
    "rejects escaping resource %s",
    (value) => expect(() => safeResourcePath(value)).toThrow()
  );
  it.each([
    "name: Bad",
    "name: bad--name",
    "description: []",
    "description: ''",
    "metadata: {key: 2}",
    "name: a\nname: b",
    "compatibility: ''"
  ])("rejects malformed frontmatter %s", (field) => {
    expect(() =>
      validateSkill({
        "SKILL.md": `---\nname: inventory-check\ndescription: Inventory\n${field}\n---\nInstructions`
      })
    ).toThrow();
  });
  it("checks names, resource limits, references, directory names and inert scripts", () => {
    expect(() => validateSkill({})).toThrow("Missing");
    expect(() => validateSkill(packageFiles(), "different")).toThrow("directory");
    expect(() => validateSkill(packageFiles("[Read](../private)"))).toThrow("inside");
    expect(() => validateSkill(packageFiles("[Read](references/missing.md)"))).toThrow(
      "Missing referenced"
    );
    expect(() => validateSkill(packageFiles("x".repeat(131073)))).toThrow("grogoni-policy");
    expect(
      validateSkill({ ...packageFiles(), "scripts/test.sh": "exit 99" }).files["scripts/test.sh"]
    ).toBe("exit 99");
    expect(
      validateSkill({ "SKILL.md": "---\nname: café\ndescription: Café\n---\nInstructions" }, "café")
        .name
    ).toBe("café");
  });
});
describe("tenant skill lifecycle and marketplace", () => {
  it("isolates private content and keeps discovery progressive", () => {
    const { domain } = fixture();
    const { draft } = enable(domain);
    expect(domain.list({ sessionId: "other", businessId: "business-b" })).toEqual([]);
    expect(() =>
      domain.inspect({ sessionId: "other", businessId: "business-b" }, draft.id)
    ).toThrow();
    expect(() =>
      domain.draft({ sessionId: "staff", businessId: "business-a" }, { files: packageFiles() })
    ).toThrow("owner");
    expect(() => domain.draft(owner, { files: packageFiles(), scope: "SYSTEM" })).toThrow("scope");
    expect(JSON.stringify(domain.catalog(owner))).not.toContain("authoritative stock");
    const active = domain.activate(owner, draft.id);
    expect(active.context).toContain("authoritative stock");
    expect(() => domain.assertAction(owner, active.ref, "product.delete")).toThrow("capability");
    domain.assertAction(owner, active.ref, "products.list");
    domain.transition(owner, draft.id, "disable");
    expect(() => domain.assertAction(owner, active.ref, "products.list")).toThrow();
    expect(() => domain.resource(owner, active.ref, "SKILL.md")).toThrow();
  });
  it("requires exact review, rejects replay and unknown capabilities, and versions updates", () => {
    const { domain } = fixture();
    expect(() =>
      domain.draft(owner, { files: packageFiles(), grants: ["invented.execute"] })
    ).toThrow();
    const { draft, digest } = enable(domain);
    expect(() => domain.transition(owner, draft.id, "install", digest)).toThrow();
    const updated = domain.update(owner, draft.id, { files: packageFiles("New instructions") });
    expect(updated.status).toBe("DRAFT");
    expect(updated.versions).toHaveLength(2);
    expect(() => domain.transition(owner, draft.id, "install", digest)).toThrow();
    expect(domain.inspect(owner, draft.id).versions[0]!.package.body).toContain(
      "authoritative stock"
    );
  });
  it("binds installation review to the grant set and exact version, not just file content", () => {
    const { domain } = fixture();
    const draft = domain.draft(owner, { files: packageFiles(), grants: [] });
    const changed = domain.update(owner, draft.id, {
      files: packageFiles(),
      grants: ["products.list"]
    });
    expect(changed.versions[0]!.package.digest).toBe(changed.versions[1]!.package.digest);
    expect(changed.reviewDigest).not.toBe(draft.reviewDigest);
    expect(() => domain.transition(owner, draft.id, "install", draft.reviewDigest)).toThrow();
    domain.transition(owner, draft.id, "install", changed.reviewDigest);
  });
  it("generates drafts without installing or granting capabilities", async () => {
    const { domain } = fixture();
    const draft = await domain.generate(owner, "Check inventory each evening");
    expect(draft.status).toBe("DRAFT");
    expect(draft.grants).toEqual([]);
    expect(domain.catalog(owner)).toEqual([]);
  });
  it("publishes a separately reviewed export and installs with explicit grants; revocation propagates", () => {
    const { domain } = fixture();
    const { draft, digest } = enable(domain);
    expect(() =>
      domain.publish(owner, draft.id, {
        digest,
        publicFiles: packageFiles(),
        publisher: "Hardware",
        category: "inventory",
        reviewedForPublication: false
      })
    ).toThrow();
    const published = domain.publish(owner, draft.id, {
      digest,
      publicFiles: packageFiles("Public stock guide"),
      publisher: "Hardware",
      category: "inventory",
      reviewedForPublication: true
    });
    const other = { sessionId: "other", businessId: "business-b" };
    expect(domain.search(other)).toHaveLength(1);
    const installed = domain.installPublic(other, published.id, published.digest, [
      "products.list"
    ]);
    domain.transition(other, installed.id, "enable");
    expect(domain.export(other, installed.id).files["SKILL.md"]).toContain("Public stock guide");
    expect(domain.export(other, installed.id).files["SKILL.md"]).not.toContain(
      "authoritative stock"
    );
    expect(() => domain.transition(other, published.id, "revoke")).toThrow();
    domain.transition(owner, published.id, "revoke");
    expect(() => domain.activate(other, installed.id)).toThrow();
    expect(domain.search(other)).toEqual([]);
  });
  it("versions public packages while keeping installed content pinned and publisher trust privileged", () => {
    const { domain } = fixture();
    const { draft, digest } = enable(domain);
    const review = {
      digest,
      publicFiles: packageFiles("Public version one"),
      publisher: "Hardware",
      category: "inventory",
      reviewedForPublication: true
    };
    expect(() => domain.publish(owner, draft.id, { ...review, trust: "verified" })).toThrow(
      "operators"
    );
    const published = domain.publish(owner, draft.id, review);
    const other = { sessionId: "other", businessId: "business-b" };
    const installed = domain.installPublic(other, published.id, published.digest, [
      "products.list"
    ]);
    domain.transition(other, installed.id, "enable");
    const next = domain.publish(owner, draft.id, {
      ...review,
      publicFiles: packageFiles("Public version two")
    });
    expect(next.id).toBe(published.id);
    expect(next.version).toBe(2);
    expect(domain.export(other, installed.id).files["SKILL.md"]).toContain("Public version one");
    domain.transition(owner, next.id, "revoke");
    expect(() => domain.activate(other, installed.id)).toThrow();
  });
  it("enforces user ownership and optional agent bindings", () => {
    const { domain } = fixture();
    const user = { sessionId: "owner" };
    const draft = domain.draft(user, { files: packageFiles(), scope: "USER" });
    expect(() => domain.inspect({ sessionId: "other" }, draft.id)).toThrow();
    const bound = domain.draft(owner, { files: packageFiles(), agentIds: ["shopkeeper"] });
    domain.transition(owner, bound.id, "install", bound.reviewDigest);
    domain.transition(owner, bound.id, "enable");
    expect(domain.catalog(owner)).toEqual([]);
    expect(domain.catalog(owner, "shopkeeper")).toHaveLength(1);
  });
});
