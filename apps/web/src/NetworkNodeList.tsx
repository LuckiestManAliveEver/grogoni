import { type NetworkNodeSummary } from "./grogoni-application-shared";

export function NetworkNodeList({ nodes, title }: { nodes: NetworkNodeSummary[]; title: string }) {
  return (
    <div className="network-list">
      <h4>{title}</h4>
      {nodes.length === 0 ? (
        <p className="shell-note">No entries yet.</p>
      ) : (
        nodes.map((node) => (
          <article key={node.id}>
            <span>{node.displayName}</span>
            <small>{node.sourcePlatform ?? node.sourceType}</small>
          </article>
        ))
      )}
    </div>
  );
}
