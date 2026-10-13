export interface InventoryReplenishmentObservation {
  businessId: string;
  observedAt: string;
  sourceRefs: string[];
  products: {
    id: string;
    businessId: string;
    onHandMilli: number;
    /** Null means missing demand evidence, never assumed zero. */
    dailyDemandMilli: number | null;
    demandSourceRefs: string[];
  }[];
  offers: {
    id: string;
    businessId: string;
    productId: string;
    supplierId: string;
    supplierActive: boolean;
    currency: string;
    unitPriceMinor: number;
    minQuantityMilli: number;
    incrementMilli: number;
    availableQuantityMilli: number;
    leadTimeDays: number;
    expiresAt: string;
    sourceRef: string;
  }[];
}

export interface InventoryReplenishmentPlan {
  status: "READY" | "PARTIAL" | "BLOCKED" | "NOTHING_TO_REPLENISH";
  businessId: string;
  currency: string;
  budgetMinor: number;
  totalMinor: number;
  remainingBudgetMinor: number;
  horizonDays: number;
  observedAt: string;
  sourceRefs: string[];
  items: {
    productId: string;
    supplierId: string;
    quoteId: string;
    quantityMilli: number;
    totalMinor: number;
    stockoutDays: number;
    comparedQuoteIds: string[];
    evidenceRefs: string[];
  }[];
  issues: {
    productId: string | null;
    code:
      | "STALE_OBSERVATION"
      | "MISSING_INVENTORY"
      | "MISSING_DEMAND"
      | "NO_ELIGIBLE_SUPPLIER"
      | "BUDGET_INSUFFICIENT";
  }[];
}

const whole = (value: number) => Number.isSafeInteger(value) && value >= 0;
const positive = (value: number) => whole(value) && value > 0;
const ceilDivide = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;

/** Deterministic advisory planning only. Submission still requires canonical authorization/approval. */
export function planInventoryReplenishment(input: {
  businessId: string;
  budgetMinor: number;
  currency: string;
  horizonDays: number;
  observation: InventoryReplenishmentObservation;
  now: Date;
}): InventoryReplenishmentPlan {
  const { observation, now } = input;
  if (
    !input.businessId ||
    observation.businessId !== input.businessId ||
    !whole(input.budgetMinor) ||
    !/^[A-Z]{3}$/u.test(input.currency) ||
    !Number.isInteger(input.horizonDays) ||
    input.horizonDays < 1 ||
    input.horizonDays > 365 ||
    !Number.isFinite(now.getTime()) ||
    observation.products.length > 500 ||
    observation.offers.length > 5000 ||
    observation.sourceRefs.length === 0 ||
    observation.sourceRefs.some((ref) => !ref.trim())
  ) {
    throw new Error("Invalid or unscoped inventory planning observation.");
  }
  const productIds = new Set<string>();
  for (const product of observation.products) {
    if (
      !product.id ||
      productIds.has(product.id) ||
      product.businessId !== input.businessId ||
      !whole(product.onHandMilli) ||
      (product.dailyDemandMilli !== null && !whole(product.dailyDemandMilli))
    ) {
      throw new Error("Invalid or cross-business inventory product.");
    }
    productIds.add(product.id);
  }
  const quoteIds = new Set<string>();
  for (const offer of observation.offers) {
    if (
      !offer.id ||
      quoteIds.has(offer.id) ||
      offer.businessId !== input.businessId ||
      !productIds.has(offer.productId) ||
      !offer.supplierId ||
      typeof offer.supplierActive !== "boolean" ||
      !offer.sourceRef.trim() ||
      !positive(offer.unitPriceMinor) ||
      !positive(offer.minQuantityMilli) ||
      !positive(offer.incrementMilli) ||
      !whole(offer.availableQuantityMilli) ||
      !whole(offer.leadTimeDays) ||
      offer.leadTimeDays > 365 ||
      !/^[A-Z]{3}$/u.test(offer.currency) ||
      !Number.isFinite(Date.parse(offer.expiresAt))
    ) {
      throw new Error("Invalid or cross-business supplier quote.");
    }
    quoteIds.add(offer.id);
  }
  const plan: InventoryReplenishmentPlan = {
    status: "NOTHING_TO_REPLENISH",
    businessId: input.businessId,
    currency: input.currency,
    budgetMinor: input.budgetMinor,
    totalMinor: 0,
    remainingBudgetMinor: input.budgetMinor,
    horizonDays: input.horizonDays,
    observedAt: observation.observedAt,
    sourceRefs: [...observation.sourceRefs],
    items: [],
    issues: []
  };
  const observedAt = Date.parse(observation.observedAt);
  if (
    !Number.isFinite(observedAt) ||
    observedAt > now.getTime() ||
    now.getTime() - observedAt > 15 * 60_000
  ) {
    plan.status = "BLOCKED";
    plan.issues.push({ productId: null, code: "STALE_OBSERVATION" });
    return plan;
  }
  let remaining = BigInt(input.budgetMinor);
  if (observation.products.length === 0) {
    plan.status = "BLOCKED";
    plan.issues.push({ productId: null, code: "MISSING_INVENTORY" });
    return plan;
  }
  const products = [...observation.products].sort((a, b) => {
    const days = (p: typeof a) =>
      p.dailyDemandMilli === null || p.dailyDemandMilli === 0
        ? Infinity
        : p.onHandMilli / p.dailyDemandMilli;
    return days(a) - days(b) || a.id.localeCompare(b.id);
  });
  for (const product of products) {
    if (
      product.dailyDemandMilli === null ||
      product.demandSourceRefs.length === 0 ||
      product.demandSourceRefs.some((ref) => !ref.trim())
    ) {
      plan.issues.push({ productId: product.id, code: "MISSING_DEMAND" });
      continue;
    }
    const demand = BigInt(product.dailyDemandMilli);
    const onHand = BigInt(product.onHandMilli);
    const required = demand * BigInt(input.horizonDays) - onHand;
    if (required <= 0n) continue;
    const offers = observation.offers
      .filter(
        (offer) =>
          offer.productId === product.id &&
          offer.supplierActive &&
          offer.currency === input.currency &&
          Date.parse(offer.expiresAt) > now.getTime() &&
          demand * BigInt(offer.leadTimeDays) <= onHand
      )
      .map((offer) => {
        const increment = BigInt(offer.incrementMilli);
        const minimum = BigInt(offer.minQuantityMilli);
        const quantity = ceilDivide(required > minimum ? required : minimum, increment) * increment;
        const cost = ceilDivide(quantity * BigInt(offer.unitPriceMinor), 1000n);
        return { offer, quantity, cost };
      })
      .filter(
        (candidate) =>
          candidate.quantity <= BigInt(candidate.offer.availableQuantityMilli) &&
          candidate.quantity <= BigInt(Number.MAX_SAFE_INTEGER)
      )
      .sort((a, b) =>
        a.cost < b.cost
          ? -1
          : a.cost > b.cost
            ? 1
            : a.offer.leadTimeDays - b.offer.leadTimeDays || a.offer.id.localeCompare(b.offer.id)
      );
    const chosen = offers[0];
    if (!chosen) {
      plan.issues.push({ productId: product.id, code: "NO_ELIGIBLE_SUPPLIER" });
      continue;
    }
    if (chosen.cost > remaining) {
      plan.issues.push({ productId: product.id, code: "BUDGET_INSUFFICIENT" });
      continue;
    }
    remaining -= chosen.cost;
    plan.items.push({
      productId: product.id,
      supplierId: chosen.offer.supplierId,
      quoteId: chosen.offer.id,
      quantityMilli: Number(chosen.quantity),
      totalMinor: Number(chosen.cost),
      stockoutDays: product.onHandMilli / product.dailyDemandMilli,
      comparedQuoteIds: offers.map((candidate) => candidate.offer.id),
      evidenceRefs: [...product.demandSourceRefs, chosen.offer.sourceRef]
    });
  }
  plan.remainingBudgetMinor = Number(remaining);
  plan.totalMinor = input.budgetMinor - plan.remainingBudgetMinor;
  plan.status = plan.issues.length
    ? plan.items.length
      ? "PARTIAL"
      : "BLOCKED"
    : plan.items.length
      ? "READY"
      : "NOTHING_TO_REPLENISH";
  return plan;
}
