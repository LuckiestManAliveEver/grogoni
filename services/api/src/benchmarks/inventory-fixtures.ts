export const inventoryBenchmarkVersion = "grogoni.retail.inventory.benchmark.v1";
export interface InventoryBenchmarkFixture {
  id: string;
  goal: string;
  budgetMinor: number;
  stock: { beans: number; rice: number };
  suppliersAvailable: boolean;
  expected: "VERIFIED_DRAFTS" | "SAFE_INCOMPLETE";
}
const base = {
  budgetMinor: 1500000,
  stock: { beans: 1, rice: 10 },
  suppliersAvailable: true,
  expected: "VERIFIED_DRAFTS" as const
};
const goal = (subject: string, budget = "15,000") =>
  `${subject} Check my inventory and prepare purchase orders within three days and a KES ${budget} budget.`;
export const inventoryBenchmarkFixtures: readonly InventoryBenchmarkFixture[] = [
  { ...base, id: "low-stock", goal: goal("Identify low-stock products.") },
  { ...base, id: "reorder-quantities", goal: goal("Calculate reorder quantities.") },
  {
    ...base,
    id: "budget",
    goal: goal("Respect the fixed budget.", "500"),
    budgetMinor: 50000,
    expected: "SAFE_INCOMPLETE"
  },
  { ...base, id: "supplier-comparison", goal: goal("Compare supplier prices.") },
  { ...base, id: "purchase-drafts", goal: goal("Prepare purchase drafts, not submitted orders.") },
  {
    ...base,
    id: "invalid-quantity",
    goal: goal("Detect invalid quantities."),
    stock: { beans: -1, rice: 10 },
    expected: "SAFE_INCOMPLETE"
  },
  {
    ...base,
    id: "unavailable-supplier",
    goal: goal("Recover from unavailable suppliers."),
    suppliersAvailable: false,
    expected: "SAFE_INCOMPLETE"
  }
];

export function assertInventoryBenchmarkDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/grogoni_[a-z0-9_]*benchmark$/u.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Inventory benchmarks require a dedicated local grogoni_*benchmark database without connection overrides."
    );
}
