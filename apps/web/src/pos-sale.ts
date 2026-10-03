import type { InvoiceSummary, PaymentMethod } from "@grogoni/shared-types";

import { postJson } from "./api-helpers";
import type { ConfirmInvoiceResponse, RecordPaymentResponse } from "./grogoni-application-shared";

export interface PosSaleLine {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface PosSaleInput {
  businessId: string;
  customerId: string | null;
  customerName: string | null;
  taxRate: number;
  items: PosSaleLine[];
  payment: {
    collectNow: boolean;
    method: PaymentMethod;
    reference: string | null;
  };
}

export interface PosSaleResult {
  invoice: InvoiceSummary;
  payment: RecordPaymentResponse | null;
}

type PosJsonRequest = <TResponse>(
  path: string,
  body: Record<string, unknown>
) => Promise<TResponse>;

export class PosPaymentRecordingError extends Error {
  readonly invoice: InvoiceSummary;
  readonly originalError: unknown;

  constructor(invoice: InvoiceSummary, originalError: unknown) {
    super("The sale was confirmed, but its payment could not be recorded.");
    this.name = "PosPaymentRecordingError";
    this.invoice = invoice;
    this.originalError = originalError;
  }
}

/**
 * Commits a POS sale through the existing sales ledger. The invoice remains the source of truth:
 * confirmation moves stock, then the optional payment is attached to that confirmed invoice.
 */
export async function completePosSale(
  input: PosSaleInput,
  request: PosJsonRequest = postJson
): Promise<PosSaleResult> {
  const invoice = await request<InvoiceSummary>(`/businesses/${input.businessId}/invoices`, {
    customerId: input.customerId,
    customerName: input.customerName,
    taxRate: input.taxRate,
    items: input.items.map(({ productId, quantity, unitPrice }) => ({
      productId,
      quantity,
      unitPrice
    }))
  });
  const confirmed = await request<ConfirmInvoiceResponse>(
    `/businesses/${input.businessId}/invoices/${invoice.id}/confirm`,
    {}
  );

  if (!input.payment.collectNow) {
    return { invoice: confirmed.invoice, payment: null };
  }

  try {
    const payment = await request<RecordPaymentResponse>(
      `/businesses/${input.businessId}/payments`,
      {
        invoiceId: confirmed.invoice.id,
        amount: confirmed.invoice.total,
        method: input.payment.method,
        reference: input.payment.reference,
        note: "Recorded through the POS terminal"
      }
    );
    return { invoice: confirmed.invoice, payment };
  } catch (error) {
    throw new PosPaymentRecordingError(confirmed.invoice, error);
  }
}
