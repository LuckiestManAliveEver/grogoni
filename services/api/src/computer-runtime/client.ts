import type {
  ComputerAction,
  ComputerActionResult,
  ComputerNavigationPolicy,
  ComputerObservation,
  ComputerSession,
  ComputerExecutionMetadata
} from "@grogoni/shared-types";

export interface ComputerWorkerClient {
  createSession(input: {
    accountId: string;
    businessId: string | null;
    conversationId: string | null;
    profileId: string | null;
    executionHostId: string;
    runtimeInstanceId: string | null;
    execution: ComputerExecutionMetadata;
    storageState: string | null;
    policy: ComputerNavigationPolicy;
  }): Promise<ComputerSession>;
  navigate(action: ComputerAction): Promise<ComputerObservation>;
  observe(sessionId: string): Promise<ComputerObservation>;
  act(action: ComputerAction, actor: "agent" | "human"): Promise<ComputerActionResult>;
  takeControl(sessionId: string): Promise<ComputerSession>;
  releaseControl(
    sessionId: string
  ): Promise<{ session: ComputerSession; observation: ComputerObservation }>;
  resume(
    sessionId: string
  ): Promise<{ session: ComputerSession; observation: ComputerObservation }>;
  storageState(sessionId: string): Promise<string>;
  frame(sessionId: string): Promise<{ contentType: string; bytes: ArrayBuffer }>;
  suspend(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
}

export class HttpComputerWorkerClient implements ComputerWorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  createSession(input: Parameters<ComputerWorkerClient["createSession"]>[0]) {
    return this.json<ComputerSession>("/v1/sessions", { method: "POST", body: input });
  }
  navigate(action: ComputerAction) {
    return this.json<ComputerObservation>(`/v1/sessions/${action.sessionId}/navigate`, {
      method: "POST",
      body: action
    });
  }
  observe(sessionId: string) {
    return this.json<ComputerObservation>(`/v1/sessions/${sessionId}/observation`);
  }
  act(action: ComputerAction, actor: "agent" | "human") {
    return this.json<ComputerActionResult>(`/v1/sessions/${action.sessionId}/actions`, {
      method: "POST",
      body: { action, actor }
    });
  }
  takeControl(sessionId: string) {
    return this.json<ComputerSession>(`/v1/sessions/${sessionId}/control/take`, { method: "POST" });
  }
  releaseControl(sessionId: string) {
    return this.json<{ session: ComputerSession; observation: ComputerObservation }>(
      `/v1/sessions/${sessionId}/control/release`,
      { method: "POST" }
    );
  }
  resume(sessionId: string) {
    return this.json<{ session: ComputerSession; observation: ComputerObservation }>(
      `/v1/sessions/${sessionId}/resume`,
      { method: "POST" }
    );
  }
  async storageState(sessionId: string) {
    return (await this.json<{ storageState: string }>(`/v1/sessions/${sessionId}/storage-state`))
      .storageState;
  }
  async frame(sessionId: string) {
    const response = await this.request(`/v1/sessions/${sessionId}/frame`);
    return {
      contentType: response.headers.get("content-type") ?? "image/jpeg",
      bytes: await response.arrayBuffer()
    };
  }
  async suspend(sessionId: string) {
    await this.json(`/v1/sessions/${sessionId}/suspend`, { method: "POST" });
  }
  async close(sessionId: string) {
    await this.json(`/v1/sessions/${sessionId}`, { method: "DELETE" });
  }

  private async json<T = unknown>(
    path: string,
    input: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const response = await this.request(path, input);
    return response.json() as Promise<T>;
  }
  private async request(path: string, input: { method?: string; body?: unknown } = {}) {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: input.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(input.body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(35_000)
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { code?: string };
      throw new Error(error.code ?? `COMPUTER_WORKER_${response.status}`);
    }
    return response;
  }
}

const unavailable = async (): Promise<never> => {
  throw new Error("COMPUTER_RUNTIME_PROVIDER_UNCONFIGURED");
};

export const unavailableComputerWorkerClient: ComputerWorkerClient = {
  createSession: unavailable,
  navigate: unavailable,
  observe: unavailable,
  act: unavailable,
  takeControl: unavailable,
  releaseControl: unavailable,
  resume: unavailable,
  storageState: unavailable,
  frame: unavailable,
  suspend: unavailable,
  close: unavailable
};
