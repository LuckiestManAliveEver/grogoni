import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  InferenceChunk,
  InferenceNodePresence,
  InferenceRequest,
  OwnerInferenceJob
} from "@grogoni/shared-types";

interface NodeRegistration {
  presence: InferenceNodePresence;
  activeJobs: Set<string>;
  send(job: OwnerInferenceJob): void;
}

interface ActiveJob {
  jobId: string;
  request: InferenceRequest;
  nodeId: string;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
  chunks: InferenceChunk[];
  sequences: Set<number>;
  waiters: Array<() => void>;
  done: boolean;
  failure: Error | null;
}

export class OwnerNodeBroker {
  private readonly nodes = new Map<string, NodeRegistration>();
  private readonly jobs = new Map<string, ActiveJob>();
  private readonly recentRequests = new Map<string, number>();

  constructor(
    private readonly options: {
      signingSecret: string;
      jobTimeoutMs: number;
      now?: () => number;
      maximumRegistrationsPerUser?: number;
    }
  ) {
    if (options.signingSecret.length < 32) {
      throw new Error("Owner-node job signing secret must contain at least 32 characters.");
    }
  }

  register(input: {
    nodeId: string;
    tenantId: string;
    userId: string;
    agentIds: string[];
    supportedModelIds: string[];
    maxConcurrentJobs: number;
    send(job: OwnerInferenceJob): void;
  }): InferenceNodePresence {
    this.expire();
    const perUser = [...this.nodes.values()].filter(
      ({ presence }) => presence.userId === input.userId
    ).length;
    if (perUser >= (this.options.maximumRegistrationsPerUser ?? 5)) {
      throw new Error("Owner-node registration rate limit reached.");
    }
    if (
      input.nodeId.trim().length === 0 ||
      input.tenantId.trim().length === 0 ||
      input.userId.trim().length === 0 ||
      input.maxConcurrentJobs < 1 ||
      input.maxConcurrentJobs > 4
    ) {
      throw new Error("Owner-node registration is invalid.");
    }
    const now = new Date(this.now()).toISOString();
    const presence: InferenceNodePresence = {
      nodeId: input.nodeId,
      tenantId: input.tenantId,
      userId: input.userId,
      agentIds: distinct(input.agentIds),
      supportedModelIds: distinct(input.supportedModelIds),
      runtimes: ["owner-node"],
      connectedAt: now,
      lastHeartbeatAt: now,
      maxConcurrentJobs: input.maxConcurrentJobs
    };
    this.nodes.set(input.nodeId, { presence, activeJobs: new Set(), send: input.send });
    return { ...presence };
  }

  heartbeat(nodeId: string, userId: string): InferenceNodePresence {
    this.expire();
    const node = this.requireOwnedNode(nodeId, userId);
    node.presence = {
      ...node.presence,
      lastHeartbeatAt: new Date(this.now()).toISOString()
    };
    return { ...node.presence };
  }

  unregister(nodeId: string, userId: string): void {
    const node = this.requireOwnedNode(nodeId, userId);
    this.nodes.delete(nodeId);
    for (const jobId of node.activeJobs) this.failJob(jobId, "Shop device disconnected.");
  }

  isReachable(input: { tenantId: string; agentId: string; modelId: string }): boolean {
    this.expire();
    return this.eligibleNodes(input).length > 0;
  }

  dispatch(request: InferenceRequest): {
    nodeId: string;
    chunks: AsyncIterable<InferenceChunk>;
  } {
    this.expire();
    const duplicateExpiresAt = this.recentRequests.get(request.requestId);
    if (duplicateExpiresAt !== undefined && duplicateExpiresAt > this.now()) {
      throw new Error("Duplicate inference request ID.");
    }
    const node = this.eligibleNodes({
      tenantId: request.tenantId,
      agentId: request.agentId,
      modelId: request.modelId
    })[0];
    if (node === undefined) throw new Error("Shop device is offline.");

    const expiresAt = this.now() + this.options.jobTimeoutMs;
    const jobId = `owner-job-${request.requestId}`;
    const token = this.sign({
      jobId,
      requestId: request.requestId,
      tenantId: request.tenantId,
      nodeId: node.presence.nodeId,
      expiresAt
    });
    const active: ActiveJob = {
      jobId,
      request,
      nodeId: node.presence.nodeId,
      expiresAt,
      timeout: setTimeout(() => {
        this.failJob(jobId, "Owner-node inference job timed out.");
      }, this.options.jobTimeoutMs),
      chunks: [],
      sequences: new Set(),
      waiters: [],
      done: false,
      failure: null
    };
    active.timeout.unref?.();
    this.jobs.set(jobId, active);
    this.recentRequests.set(request.requestId, expiresAt);
    node.activeJobs.add(jobId);
    node.send({
      jobId,
      jobToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      request
    });
    return {
      nodeId: node.presence.nodeId,
      chunks: this.stream(active)
    };
  }

  acceptChunk(input: {
    nodeId: string;
    userId: string;
    jobToken: string;
    sequence: number;
    chunk: InferenceChunk;
  }): void {
    this.expire();
    this.requireOwnedNode(input.nodeId, input.userId);
    const claims = this.verify(input.jobToken);
    const job = this.jobs.get(claims.jobId);
    if (
      job === undefined ||
      job.nodeId !== input.nodeId ||
      claims.nodeId !== input.nodeId ||
      claims.tenantId !== job.request.tenantId ||
      claims.requestId !== job.request.requestId ||
      input.chunk.requestId !== job.request.requestId ||
      input.chunk.modelId !== job.request.modelId ||
      input.chunk.runtime !== "owner-node" ||
      !Number.isInteger(input.sequence) ||
      input.sequence < 0
    ) {
      throw new Error("Owner-node inference chunk is not authorized.");
    }
    if (job.sequences.has(input.sequence)) throw new Error("Replayed inference chunk.");
    job.sequences.add(input.sequence);
    job.chunks.push(input.chunk);
    if (input.chunk.done) {
      job.done = true;
      clearTimeout(job.timeout);
      this.nodes.get(job.nodeId)?.activeJobs.delete(job.jobId);
    }
    this.wake(job);
  }

  listPresence(tenantId: string): InferenceNodePresence[] {
    this.expire();
    return [...this.nodes.values()]
      .map(({ presence }) => presence)
      .filter((presence) => presence.tenantId === tenantId)
      .map((presence) => ({ ...presence }));
  }

  private eligibleNodes(input: {
    tenantId: string;
    agentId: string;
    modelId: string;
  }): NodeRegistration[] {
    return [...this.nodes.values()]
      .filter(
        (node) =>
          node.presence.tenantId === input.tenantId &&
          node.presence.agentIds.includes(input.agentId) &&
          node.presence.supportedModelIds.includes(input.modelId) &&
          node.activeJobs.size < node.presence.maxConcurrentJobs
      )
      .sort(
        (left, right) =>
          left.activeJobs.size - right.activeJobs.size ||
          left.presence.nodeId.localeCompare(right.presence.nodeId)
      );
  }

  private async *stream(job: ActiveJob): AsyncIterable<InferenceChunk> {
    try {
      while (!job.done || job.chunks.length > 0) {
        const chunk = job.chunks.shift();
        if (chunk !== undefined) {
          yield chunk;
          continue;
        }
        await new Promise<void>((resolve) => job.waiters.push(resolve));
      }
      if (job.failure !== null) throw job.failure;
    } finally {
      clearTimeout(job.timeout);
      this.jobs.delete(job.jobId);
      this.nodes.get(job.nodeId)?.activeJobs.delete(job.jobId);
    }
  }

  private expire(): void {
    const now = this.now();
    for (const [jobId, job] of this.jobs) {
      if (job.expiresAt <= now) this.failJob(jobId, "Owner-node inference job timed out.");
    }
    for (const [requestId, expiresAt] of this.recentRequests) {
      if (expiresAt <= now) this.recentRequests.delete(requestId);
    }
    for (const [nodeId, node] of this.nodes) {
      if (Date.parse(node.presence.lastHeartbeatAt) + 90_000 <= now) {
        this.nodes.delete(nodeId);
        for (const jobId of node.activeJobs) this.failJob(jobId, "Shop device disconnected.");
      }
    }
  }

  private failJob(jobId: string, message: string): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) return;
    clearTimeout(job.timeout);
    job.failure = new Error(message);
    job.done = true;
    this.wake(job);
  }

  private requireOwnedNode(nodeId: string, userId: string): NodeRegistration {
    const node = this.nodes.get(nodeId);
    if (node === undefined || node.presence.userId !== userId) {
      throw new Error("Owner-node access is forbidden.");
    }
    return node;
  }

  private sign(claims: JobClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = createHmac("sha256", this.options.signingSecret)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  private verify(token: string): JobClaims {
    const [payload, signature] = token.split(".");
    if (payload === undefined || signature === undefined) throw new Error("Invalid job token.");
    const expected = createHmac("sha256", this.options.signingSecret).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("Invalid job token.");
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JobClaims;
    if (claims.expiresAt <= this.now()) throw new Error("Expired job token.");
    return claims;
  }

  private wake(job: ActiveJob): void {
    job.waiters.splice(0).forEach((resolve) => resolve());
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

interface JobClaims {
  jobId: string;
  requestId: string;
  tenantId: string;
  nodeId: string;
  expiresAt: number;
}

function distinct(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}
