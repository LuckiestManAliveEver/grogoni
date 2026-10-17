import { describe, expect, it } from "vitest";
import { NativeRuntimeBindingStore } from "../services/api/src/cp2/domains/native-runtime/store";

/**
 * Every Edge request restores the snapshot, which runs ensureGlobalDefault. When that stamped the
 * shared built-in agent's updatedAt each time, every signed-in request wrote the same row, and
 * concurrent requests lost their optimistic save (40001) and answered 503 in production.
 */
describe("native runtime global default", () => {
  function persisted(store: NativeRuntimeBindingStore) {
    return {
      nativeRuntimeAgents: [...store.agentsMap.values()].map((agent) => structuredClone(agent)),
      nativeRuntimeBindings: [...store.bindingsMap.values()].map((binding) =>
        structuredClone(binding)
      )
    };
  }

  it("leaves an up-to-date built-in agent untouched on every restore", () => {
    const first = new NativeRuntimeBindingStore();
    const saved = persisted(first);
    const next = new NativeRuntimeBindingStore();
    next.restore(saved);
    next.ensureGlobalDefault(new Date(Date.now() + 60_000));
    expect(persisted(next)).toEqual(saved);
  });

  it("still repairs a built-in agent whose stored content drifted, keeping its createdAt", () => {
    const saved = persisted(new NativeRuntimeBindingStore());
    const original = saved.nativeRuntimeAgents[0]!;
    const drifted = { ...original, name: "Stale name", status: "inactive" as const };
    const store = new NativeRuntimeBindingStore();
    const later = new Date(Date.parse(original.updatedAt) + 60_000);
    store.restore({ ...saved, nativeRuntimeAgents: [drifted] });
    store.ensureGlobalDefault(later);
    const repaired = store.agentsMap.get(original.id)!;
    expect(repaired.name).toBe(original.name);
    expect(repaired.status).toBe("active");
    expect(repaired.createdAt).toBe(original.createdAt);
  });

  it("creates the built-in agent when the snapshot has none", () => {
    const store = new NativeRuntimeBindingStore();
    store.restore({});
    expect(store.agentsMap.size).toBe(1);
  });
});
