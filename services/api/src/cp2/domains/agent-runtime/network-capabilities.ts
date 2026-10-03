import type { RuntimePlannedAction } from "@grogoni/shared-types";

import { Cp2Error } from "../../cp2-error.js";
import type { AgentRuntimeDomainDeps } from "./store.js";

export function executeNetworkCapability(
  deps: AgentRuntimeDomainDeps,
  input: {
    sessionId: string | null;
    action: RuntimePlannedAction;
    now: Date;
  }
): unknown {
  const values = input.action.input;

  switch (input.action.toolName) {
    case "network.route":
      return deps.createAgentRoute({
        sessionId: input.sessionId,
        requestText: String(values.requestText ?? ""),
        ...(typeof values.targetNodeId === "string" ? { targetNodeId: values.targetNodeId } : {}),
        now: input.now
      });

    case "network.contacts.resolve":
      return deps.resolveContact({
        sessionId: input.sessionId,
        query: String(values.query ?? ""),
        now: input.now
      });

    case "network.identity.list":
      return deps.listIdentityCandidates({
        sessionId: input.sessionId,
        now: input.now
      });

    case "network.identity.propose":
      return deps.proposeIdentityCandidate({
        sessionId: input.sessionId,
        provider: String(values.provider ?? ""),
        providerSubject: String(values.providerSubject ?? ""),
        displayName: String(values.displayName ?? ""),
        handle: typeof values.handle === "string" ? values.handle : null,
        evidence: String(values.evidence ?? ""),
        now: input.now
      });

    case "network.identity.confirm":
      return deps.confirmIdentityCandidate({
        sessionId: input.sessionId,
        candidateId: String(values.candidateId ?? ""),
        targetNodeId: typeof values.targetNodeId === "string" ? values.targetNodeId : null,
        createNewContact: values.createNewContact === true,
        now: input.now
      });

    case "network.identity.reject":
      deps.rejectIdentityCandidate({
        sessionId: input.sessionId,
        candidateId: String(values.candidateId ?? ""),
        now: input.now
      });
      return { rejected: true };

    case "network.identity.unlink":
      return deps.unlinkIdentity({
        sessionId: input.sessionId,
        nodeId: String(values.nodeId ?? ""),
        externalIdentityId: String(values.externalIdentityId ?? ""),
        now: input.now
      });

    case "network.identity.add":
      return deps.addManualIdentity({
        sessionId: input.sessionId,
        nodeId: String(values.nodeId ?? ""),
        provider: String(values.provider ?? ""),
        providerSubject: String(values.providerSubject ?? ""),
        ...(typeof values.displayName === "string" ? { displayName: values.displayName } : {}),
        handle: typeof values.handle === "string" ? values.handle : null,
        now: input.now
      });

    default:
      throw new Cp2Error(
        400,
        "runtime_capability_not_found",
        `${input.action.toolName} is not a network capability.`
      );
  }
}
