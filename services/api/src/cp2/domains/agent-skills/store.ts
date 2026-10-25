import { createHash, randomUUID } from "node:crypto";
import { runtimeToolRegistry } from "@grogoni/tool-core";
import type { RuntimeToolName } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import {
  validateSkill,
  skillContext,
  skillMetadata,
  safeResourcePath,
  type SkillPackage
} from "./format.js";

export interface SkillRef {
  id: string;
  version: number;
  digest: string;
}
export interface SkillActor {
  userId: string;
  accountId: string;
  role: string;
  operator: boolean;
}
export interface SkillRequest {
  sessionId: string | null;
  businessId?: string;
  now?: Date;
}
export interface SkillVersion {
  version: number;
  package: SkillPackage;
  createdAt: string;
}
export interface SkillRecord {
  id: string;
  businessId: string | null;
  accountId: string | null;
  scope: "SYSTEM" | "TENANT" | "USER";
  kind: "installation" | "publication";
  ownerUserId: string;
  status: "DRAFT" | "INSTALLED" | "ENABLED" | "DISABLED" | "UNINSTALLED" | "REVOKED";
  versions: SkillVersion[];
  currentVersion: number;
  reviewDigest: string;
  validationStatus: "VALIDATED";
  specificationReference: string;
  grants: RuntimeToolName[];
  agentIds: string[];
  source: string;
  publisher: string | null;
  trust: "platform" | "verified" | "community" | "private";
  category: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface SkillInput {
  files: Record<string, string>;
  scope?: "SYSTEM" | "TENANT" | "USER";
  grants?: string[];
  agentIds?: string[];
  source?: string;
}
const categories = [
  "inventory",
  "sales",
  "customer-support",
  "supplier-management",
  "logistics",
  "accounting",
  "business-reporting"
];
const denied = (): never => {
  throw new Cp2Error(404, "skill_not_found", "Skill is unavailable.");
};
export class AgentSkillsDomain {
  readonly records = new Map<string, SkillRecord>();
  constructor(
    private readonly deps: {
      authorize: (input: SkillRequest) => SkillActor;
      audit: (actorId: string, id: string, event: string, details: Record<string, unknown>) => void;
      generate: (input: SkillRequest, description: string) => Promise<Record<string, string>>;
      agentAllowed: (businessId: string, agentId: string) => boolean;
    }
  ) {}
  private actor(input: SkillRequest, write = false) {
    const actor = this.deps.authorize(input);
    if (write && input.businessId && actor.role !== "owner")
      throw new Cp2Error(403, "skill_owner_required", "Only the business owner can manage skills.");
    return actor;
  }
  private visible(record: SkillRecord, actor: SkillActor, businessId?: string): boolean {
    return (
      record.kind === "publication" ||
      record.scope === "SYSTEM" ||
      (record.scope === "TENANT"
        ? record.businessId === businessId
        : record.accountId === actor.accountId)
    );
  }
  private get(input: SkillRequest, id: string, write = false): SkillRecord {
    const actor = this.actor(input, write);
    const record = this.records.get(id);
    if (!record || !this.visible(record, actor, input.businessId)) return denied();
    if (
      write &&
      ((record.kind === "publication" && record.ownerUserId !== actor.userId && !actor.operator) ||
        (record.kind === "installation" && record.scope === "SYSTEM" && !actor.operator) ||
        (record.kind === "installation" &&
          record.scope === "USER" &&
          record.accountId !== actor.accountId))
    )
      return denied();
    return record;
  }
  private review(record: SkillRecord) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          digest: this.current(record).package.digest,
          version: record.currentVersion,
          grants: record.grants,
          agents: record.agentIds,
          scope: record.scope,
          businessId: record.businessId,
          accountId: record.accountId
        })
      )
      .digest("hex");
  }
  private current(record: SkillRecord): SkillVersion {
    return record.versions.find((v) => v.version === record.currentVersion)!;
  }
  private event(input: SkillRequest, record: SkillRecord, event: string) {
    record.updatedAt = (input.now ?? new Date()).toISOString();
    this.deps.audit(this.actor(input).userId, record.id, event, {
      version: record.currentVersion,
      digest: this.current(record).package.digest,
      scope: record.scope
    });
  }
  private grants(values: string[] = []): RuntimeToolName[] {
    if (
      !Array.isArray(values) ||
      values.length > 100 ||
      values.some((v) => typeof v !== "string" || !Object.hasOwn(runtimeToolRegistry, v))
    )
      throw new Cp2Error(
        400,
        "skill_capability_unknown",
        "Every capability must exist in the Grogoni tool registry."
      );
    return [...new Set(values)] as RuntimeToolName[];
  }
  list(input: SkillRequest) {
    const actor = this.actor(input);
    return [...this.records.values()]
      .filter(
        (r) =>
          r.kind === "installation" &&
          this.visible(r, actor, input.businessId) &&
          r.status !== "UNINSTALLED"
      )
      .map((r) => ({
        id: r.id,
        ...skillMetadata(this.current(r).package),
        version: r.currentVersion,
        scope: r.scope,
        status: r.status,
        grants: [...r.grants],
        agentIds: [...r.agentIds],
        source: r.source
      }));
  }
  inspect(input: SkillRequest, id: string) {
    return structuredClone(this.get(input, id));
  }
  draft(input: SkillRequest, values: SkillInput): SkillRecord {
    const actor = this.actor(input, true);
    const scope = values.scope ?? (input.businessId ? "TENANT" : "USER");
    if (
      !["SYSTEM", "TENANT", "USER"].includes(scope) ||
      (scope === "TENANT" && !input.businessId) ||
      (scope === "SYSTEM" && !actor.operator)
    )
      throw new Cp2Error(403, "skill_scope_denied", "Skill scope is not authorized.");
    if (
      values.source !== undefined &&
      (typeof values.source !== "string" || values.source.length > 256)
    )
      throw new Cp2Error(400, "skill_source_invalid", "Source must be a bounded string.");
    const pkg = validateSkill(values.files);
    if (
      [...this.records.values()].filter(
        (r) => r.ownerUserId === actor.userId && r.status !== "UNINSTALLED"
      ).length >= 100
    )
      throw new Cp2Error(
        409,
        "skill_quota_exceeded",
        "At most 100 installed skills or drafts per owner."
      );
    if (values.source === "generated")
      this.grants((pkg["allowed-tools"] ?? "").split(/\s+/).filter(Boolean));
    const grants = this.grants(values.grants);
    const agentIds = values.agentIds ?? [];
    if (
      !Array.isArray(agentIds) ||
      agentIds.length > 100 ||
      agentIds.some(
        (id) =>
          typeof id !== "string" ||
          !id ||
          (input.businessId && !this.deps.agentAllowed(input.businessId, id))
      )
    )
      throw new Cp2Error(
        400,
        "skill_agent_invalid",
        "Bind only agents belonging to this business."
      );
    const now = (input.now ?? new Date()).toISOString();
    const record: SkillRecord = {
      id: randomUUID(),
      businessId: scope === "TENANT" ? input.businessId! : null,
      accountId: scope === "USER" ? actor.accountId : null,
      ownerUserId: actor.userId,
      kind: "installation",
      scope,
      status: "DRAFT",
      versions: [{ version: 1, package: pkg, createdAt: now }],
      currentVersion: 1,
      reviewDigest: "",
      validationStatus: "VALIDATED",
      specificationReference: "https://agentskills.io/specification",
      grants,
      agentIds: [...new Set(agentIds)],
      source: values.source ?? "owner",
      publisher: null,
      trust: scope === "SYSTEM" ? "platform" : "private",
      category: null,
      createdAt: now,
      updatedAt: now
    };
    record.reviewDigest = this.review(record);
    this.records.set(record.id, record);
    this.event(input, record, "drafted");
    return structuredClone(record);
  }
  async generate(input: SkillRequest, description: string) {
    this.actor(input, true);
    if (typeof description !== "string" || !description.trim() || description.length > 10000)
      throw new Cp2Error(400, "skill_intent_invalid", "Describe the proposed business procedure.");
    const files = await this.deps.generate(input, description);
    // Reauthorize after inference. Generated content never grants permissions or installs itself.
    return this.draft(input, { files, grants: [], source: "generated" });
  }
  update(input: SkillRequest, id: string, values: SkillInput) {
    const r = this.get(input, id, true);
    if (
      r.kind !== "installation" ||
      ["REVOKED", "UNINSTALLED"].includes(r.status) ||
      r.versions.length >= 100
    )
      throw new Cp2Error(409, "skill_update_denied", "Skill cannot be updated.");
    const pkg = validateSkill(values.files);
    const grants = this.grants(values.grants ?? r.grants);
    if (
      values.agentIds !== undefined &&
      (!Array.isArray(values.agentIds) ||
        values.agentIds.length > 100 ||
        values.agentIds.some(
          (a) => !input.businessId || !this.deps.agentAllowed(input.businessId, a)
        ))
    )
      throw new Cp2Error(400, "skill_agent_invalid", "Agent binding is invalid.");
    if (JSON.stringify(r.versions).length + JSON.stringify(pkg).length > 16 * 1024 * 1024)
      throw new Cp2Error(400, "skill_history_limit", "Skill history exceeds the resource budget.");
    r.currentVersion += 1;
    r.versions.push({
      version: r.currentVersion,
      package: pkg,
      createdAt: (input.now ?? new Date()).toISOString()
    });
    r.grants = grants;
    r.agentIds = values.agentIds ?? r.agentIds;
    r.reviewDigest = this.review(r);
    r.status = "DRAFT"; // A changed package or permission set needs a new review.
    this.event(input, r, "updated");
    return structuredClone(r);
  }
  transition(
    input: SkillRequest,
    id: string,
    operation: "install" | "enable" | "disable" | "uninstall" | "revoke",
    digest?: string
  ) {
    const r = this.get(input, id, true);
    const allowed = {
      install: ["DRAFT"],
      enable: ["INSTALLED", "DISABLED"],
      disable: ["ENABLED"],
      uninstall: ["DRAFT", "INSTALLED", "ENABLED", "DISABLED"],
      revoke: ["DRAFT", "INSTALLED", "ENABLED", "DISABLED"]
    };
    if (
      !allowed[operation]?.includes(r.status) ||
      (operation === "install" && digest !== r.reviewDigest)
    )
      throw new Cp2Error(
        409,
        "skill_review_required",
        "Review the exact package digest before this transition."
      );
    r.status = (
      {
        install: "INSTALLED",
        enable: "ENABLED",
        disable: "DISABLED",
        uninstall: "UNINSTALLED",
        revoke: "REVOKED"
      } as const
    )[operation];
    this.event(input, r, operation);
    return { id: r.id, status: r.status };
  }
  catalog(input: SkillRequest, agentId?: string) {
    return this.list(input)
      .filter(
        (r) =>
          r.status === "ENABLED" &&
          (!r.agentIds.length || (agentId !== undefined && r.agentIds.includes(agentId)))
      )
      .slice(0, 100)
      .map(({ id, name, description, digest, version }) => ({
        id,
        name,
        description,
        digest,
        version
      }));
  }
  activate(input: SkillRequest, selector: string, agentId?: string) {
    const matches = this.catalog(input, agentId).filter(
      (r) => r.id === selector || r.name === selector
    );
    if (matches.length !== 1) return denied();
    const r = this.get(input, matches[0]!.id);
    const version = this.current(r);
    const checked = validateSkill(version.package.files);
    if (checked.digest !== version.package.digest)
      throw new Cp2Error(
        409,
        "skill_integrity_failed",
        "Installed package integrity check failed."
      );
    if (r.source.startsWith("marketplace:")) {
      const publication = this.records.get(r.source.slice("marketplace:".length));
      if (!publication || publication.status === "REVOKED") return denied();
    }
    this.deps.audit(this.actor(input).userId, r.id, "activated", {
      version: version.version,
      digest: version.package.digest,
      agentId: agentId ?? null,
      businessId: input.businessId ?? null
    });
    return {
      ref: { id: r.id, version: version.version, digest: version.package.digest },
      context: skillContext(checked),
      grants: [...r.grants]
    };
  }
  assertAction(input: SkillRequest, ref: SkillRef, tool: string, agentId?: string) {
    const active = this.activate(input, ref.id, agentId);
    const declared = this.current(this.get(input, ref.id)).package["allowed-tools"];
    if (
      tool !== "unknown.clarify" &&
      declared !== undefined &&
      !declared.split(/\s+/).includes(tool)
    )
      throw new Cp2Error(
        403,
        "skill_capability_denied",
        "The skill does not declare this capability."
      );
    if (
      active.ref.version !== ref.version ||
      active.ref.digest !== ref.digest ||
      (!active.grants.includes(tool as RuntimeToolName) && tool !== "unknown.clarify")
    )
      throw new Cp2Error(
        403,
        "skill_capability_denied",
        "The skill version or requested capability is no longer authorized."
      );
  }
  resource(input: SkillRequest, ref: SkillRef, resource: string, agentId?: string) {
    const active = this.activate(input, ref.id, agentId);
    if (active.ref.digest !== ref.digest || active.ref.version !== ref.version) return denied();
    const pkg = this.current(this.get(input, ref.id)).package;
    const key = safeResourcePath(resource);
    if (!Object.hasOwn(pkg.files, key)) return denied();
    return { content: pkg.files[key], executable: false };
  }
  publish(
    input: SkillRequest,
    id: string,
    review: {
      digest: string;
      publicFiles: Record<string, string>;
      publisher: string;
      category: string;
      reviewedForPublication: boolean;
      trust?: "platform" | "verified" | "community";
    }
  ) {
    const r = this.get(input, id, true);
    if (
      r.kind !== "installation" ||
      !["INSTALLED", "ENABLED", "DISABLED"].includes(r.status) ||
      review.digest !== this.current(r).package.digest ||
      review.reviewedForPublication !== true ||
      !categories.includes(review.category) ||
      typeof review.publisher !== "string" ||
      !review.publisher.trim() ||
      review.publisher.length > 100
    )
      throw new Cp2Error(
        400,
        "skill_publication_review_required",
        "Review an explicit public package, publisher and category."
      );
    // The caller must supply a separate reviewed export; never copy private business content implicitly.
    const pkg = validateSkill(review.publicFiles);
    if (!pkg.license?.trim())
      throw new Cp2Error(
        400,
        "skill_license_required",
        "Public packages need explicit redistribution terms."
      );
    if (
      [...this.records.values()].some(
        (p) =>
          p.kind === "publication" &&
          p.status === "REVOKED" &&
          p.versions.some((v) => v.package.digest === pkg.digest)
      )
    )
      throw new Cp2Error(409, "skill_content_revoked", "This public package has been revoked.");
    const actor = this.actor(input, true);
    const requestedTrust = review.trust ?? "community";
    if (
      !["platform", "verified", "community"].includes(requestedTrust) ||
      (requestedTrust !== "community" && !actor.operator)
    )
      throw new Cp2Error(
        403,
        "skill_publisher_verification_required",
        "Only platform operators may attest publisher trust."
      );
    const previous = [...this.records.values()].find(
      (p) =>
        p.kind === "publication" &&
        p.ownerUserId === actor.userId &&
        this.current(p).package.name === pkg.name &&
        p.status !== "REVOKED"
    );
    if (previous) {
      if (this.current(previous).package.digest === pkg.digest)
        return this.publicMetadata(previous);
      if (
        previous.versions.length >= 100 ||
        JSON.stringify(previous.versions).length + JSON.stringify(pkg).length > 16 * 1024 * 1024
      )
        throw new Cp2Error(
          400,
          "skill_history_limit",
          "Publication history exceeds its resource budget."
        );
      previous.currentVersion += 1;
      previous.versions.push({
        version: previous.currentVersion,
        package: pkg,
        createdAt: (input.now ?? new Date()).toISOString()
      });
      previous.publisher = review.publisher.trim();
      previous.trust = requestedTrust;
      previous.category = review.category;
      previous.reviewDigest = this.review(previous);
      this.event(input, previous, "published");
      return this.publicMetadata(previous);
    }
    const record: SkillRecord = {
      ...structuredClone(r),
      id: randomUUID(),
      businessId: null,
      accountId: null,
      scope: "SYSTEM",
      kind: "publication",
      status: "INSTALLED",
      versions: [{ version: 1, package: pkg, createdAt: (input.now ?? new Date()).toISOString() }],
      currentVersion: 1,
      grants: [],
      agentIds: [],
      source: "publication",
      publisher: review.publisher.trim(),
      trust: requestedTrust,
      category: review.category
    };
    record.reviewDigest = this.review(record);
    this.records.set(record.id, record);
    this.event(input, record, "published");
    return this.publicMetadata(record);
  }
  private publicMetadata(r: SkillRecord) {
    return {
      id: r.id,
      ...skillMetadata(this.current(r).package),
      publisher: r.publisher,
      trust: r.trust,
      category: r.category,
      version: r.currentVersion,
      requiredCapabilities: (this.current(r).package["allowed-tools"] ?? "")
        .split(/\s+/)
        .filter(Boolean),
      license: this.current(r).package.license
    };
  }
  search(input: SkillRequest, query = "") {
    this.actor(input);
    return [...this.records.values()]
      .filter(
        (r) =>
          r.kind === "publication" &&
          r.status !== "REVOKED" &&
          `${this.current(r).package.name} ${this.current(r).package.description} ${r.category}`
            .toLowerCase()
            .includes(query.toLowerCase())
      )
      .map((r) => this.publicMetadata(r));
  }
  installPublic(input: SkillRequest, id: string, digest: string, grants: string[]) {
    this.actor(input, true);
    const publication = this.get(input, id);
    if (
      publication.kind !== "publication" ||
      publication.status === "REVOKED" ||
      this.current(publication).package.digest !== digest
    )
      return denied();
    const draft = this.draft(input, {
      files: this.current(publication).package.files,
      grants,
      source: `marketplace:${id}`
    });
    this.transition(input, draft.id, "install", draft.reviewDigest);
    return this.inspect(input, draft.id);
  }
  export(input: SkillRequest, id: string) {
    const r = this.get(input, id);
    return {
      directory: this.current(r).package.name,
      files: structuredClone(this.current(r).package.files)
    };
  }
}
