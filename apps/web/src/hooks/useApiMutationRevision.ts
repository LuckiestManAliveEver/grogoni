import { useEffect, useState } from "react";

import { subscribeToApiMutations } from "../api-request-cache";

export function useApiMutationRevision(...resourcePrefixes: string[]): number {
  const [revision, setRevision] = useState(0);
  const resourceKey = resourcePrefixes.join("\u0000");

  useEffect(() => {
    const prefixes = resourceKey.split("\u0000").filter((prefix) => prefix.length > 0);
    return subscribeToApiMutations((path) => {
      if (
        prefixes.some(
          (prefix) =>
            path === prefix ||
            path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`) ||
            prefix.startsWith(path.endsWith("/") ? path : `${path}/`)
        )
      ) {
        setRevision((current) => current + 1);
      }
    });
  }, [resourceKey]);

  return revision;
}
