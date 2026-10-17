import { useRef, useState } from "react";

export function useAsyncActions() {
  const activeActions = useRef(new Set<string>());
  const [pendingActions, setPendingActions] = useState<string[]>([]);

  async function runAction<T>(key: string, action: () => Promise<T>): Promise<T | undefined> {
    if (activeActions.current.has(key)) return undefined;
    activeActions.current.add(key);
    setPendingActions((current) => [...current, key]);
    try {
      return await action();
    } finally {
      activeActions.current.delete(key);
      setPendingActions((current) => current.filter((item) => item !== key));
    }
  }

  return {
    hasPending: pendingActions.length > 0,
    isPending: (key: string) => pendingActions.includes(key),
    /** Whether an action is running right now; current even from an older render's closure. */
    isRunning: (key: string) => activeActions.current.has(key),
    runAction
  };
}
