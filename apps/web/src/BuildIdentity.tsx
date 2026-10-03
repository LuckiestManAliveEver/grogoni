import { AppIcon } from "./AppIcon";

import { buildIdentity, showBuildIdentity } from "./grogoni-application-shared";

export function BuildIdentity() {
  if (!showBuildIdentity) {
    return null;
  }

  return (
    <span className="build-identity">
      {buildIdentity.environment} · v{buildIdentity.version} ·{" "}
      {formatShortCommit(buildIdentity.commitSha)} · built {buildIdentity.buildTimestamp}
    </span>
  );
}

export function NativeLaunchScreen({ message }: { message: string }) {
  return (
    <main className="native-launch-screen" aria-busy="true" aria-live="polite">
      <AppIcon className="route-brand-icon" />
      <h1>Grogoni</h1>
      <p>{message}</p>
    </main>
  );
}

export function formatShortCommit(commitSha: string): string {
  return commitSha === "local" ? "local" : commitSha.slice(0, 7);
}
