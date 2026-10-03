import type { NetworkNodeSummary } from "@grogoni/shared-types";

export function sanitizeNetworkNode(node: NetworkNodeSummary): NetworkNodeSummary {
  if (node.degree !== 2) {
    return node;
  }

  return {
    ...node,
    contactHashIds: []
  };
}
