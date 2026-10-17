/** Snapshot-backed domain requests take an actor/store lock on the Edge API. Sending a shop's
 * entire startup burst together makes requests time out waiting for each other. Keep one in
 * flight per tab and let user mutations pass background reads already waiting in the queue.
 * Authentication, daemon leases and preview streams use independent paths and bypass this queue.
 */
export function createCloudRequestQueue() {
  const waiting: Array<{ priority: boolean; start: () => void }> = [];
  let active = false;
  function drain() {
    if (active) return;
    const next = waiting.shift();
    if (!next) return;
    active = true;
    next.start();
  }
  return function run<T>(
    action: () => Promise<T>,
    priority = false,
    signal?: AbortSignal
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const abort = () => {
        const index = waiting.indexOf(entry);
        if (index !== -1) {
          waiting.splice(index, 1);
          reject(signal?.reason);
        }
      };
      const entry = {
        priority,
        start() {
          signal?.removeEventListener("abort", abort);
          void Promise.resolve()
            .then(action)
            .then(resolve, reject)
            .finally(() => {
              active = false;
              drain();
            });
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      const firstRead = priority ? waiting.findIndex((item) => !item.priority) : -1;
      if (firstRead === -1) waiting.push(entry);
      else waiting.splice(firstRead, 0, entry);
      drain();
    });
  };
}

export function isSnapshotRequest(url: string): boolean {
  return !/\/(?:auth\/|health(?:[/?]|$)|v1\/daemon\/|v1\/ai\/turn-stream\/)/u.test(url);
}
export const queueCloudRequest = createCloudRequestQueue();
