import {
  invalid,
  valid,
  type RuntimeToolName,
  type ValidationResult
} from "../contracts/runtime.js";

export function validateRuntimeToolInput(
  toolName: RuntimeToolName,
  input: Record<string, unknown>
): ValidationResult {
  if (
    toolName.startsWith("computer.") &&
    toolName !== "computer.session.create" &&
    (typeof input.sessionId !== "string" || input.sessionId.trim().length === 0)
  ) {
    return invalid("Choose a computer session first. Use #computer.session.create to open one.");
  }
  switch (toolName) {
    case "procurement.submit": {
      const allowed = [
        "draftId",
        "draftDigest",
        "channel",
        "recipient",
        "mailboxId",
        "optInConfirmed"
      ];
      if (Object.keys(input).some((key) => !allowed.includes(key)))
        return invalid("Unexpected purchase order arguments.");
      if (
        typeof input.draftId !== "string" ||
        !input.draftId.trim() ||
        input.draftId.length > 200 ||
        typeof input.draftDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.draftDigest) ||
        typeof input.recipient !== "string" ||
        !input.recipient.trim() ||
        input.recipient.length > 254 ||
        /[\r\n]/.test(input.recipient)
      )
        return invalid("An exact draft digest and recipient are required.");
      if (input.channel === "grogoni")
        return input.mailboxId === undefined && input.optInConfirmed === undefined
          ? valid()
          : invalid("Inbox orders do not use external channel settings.");
      if (input.optInConfirmed !== true)
        return invalid("Supplier consent to the external channel must be confirmed.");
      if (input.channel === "email")
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.recipient) &&
          typeof input.mailboxId === "string" &&
          !!input.mailboxId.trim() &&
          input.mailboxId.length <= 200
          ? valid()
          : invalid("A supplier email and exact sending mailbox are required.");
      if (input.channel === "whatsapp")
        return /^\+[1-9][0-9]{7,14}$/.test(input.recipient) && input.mailboxId === undefined
          ? valid()
          : invalid("WhatsApp requires an E.164 number.");
      return invalid("Select a supported order delivery channel.");
    }
    case "procurement.respond":
      return Object.keys(input).every((key) => ["orderId", "revision", "decision"].includes(key)) &&
        typeof input.orderId === "string" &&
        !!input.orderId.trim() &&
        input.orderId.length <= 200 &&
        Number.isSafeInteger(input.revision) &&
        Number(input.revision) >= 0 &&
        ["ACCEPTED", "REJECTED"].includes(String(input.decision))
        ? valid()
        : invalid("An exact order, revision and decision are required.");
    case "procurement.prepare":
      return typeof input.taskId === "string" &&
        input.taskId.trim().length > 0 &&
        input.taskId.length <= 200
        ? valid()
        : invalid("An existing environment task identifier is required.");
    case "procurement.quote.record": {
      if (typeof input.unit !== "string" || !input.unit.trim() || input.unit.length > 100)
        return invalid("The canonical product quantity unit is required.");
      if (input.priceIncludesCharges !== true)
        return invalid("The quote must explicitly include all charges in its unit price.");
      for (const key of ["id", "productId", "supplierId"]) {
        if (
          typeof input[key] !== "string" ||
          !(input[key] as string).trim() ||
          (input[key] as string).length > 200
        )
          return invalid("Quote, supplier and product identifiers are required.");
      }
      if (
        typeof input.currency !== "string" ||
        !/^[A-Z]{3}$/u.test(input.currency) ||
        typeof input.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(input.expiresAt))
      )
        return invalid("Quote currency and expiry must be valid.");
      for (const key of ["unitPriceMinor", "minQuantityMilli", "incrementMilli"]) {
        if (!Number.isSafeInteger(input[key]) || Number(input[key]) <= 0)
          return invalid("Quote prices, minimums and increments must be positive safe integers.");
      }
      if (
        !Number.isSafeInteger(input.availableQuantityMilli) ||
        Number(input.availableQuantityMilli) < 0 ||
        !Number.isInteger(input.leadTimeDays) ||
        Number(input.leadTimeDays) < 0 ||
        Number(input.leadTimeDays) > 365
      )
        return invalid("Quote availability and lead time must be bounded nonnegative integers.");
      return valid();
    }
    case "products.list":
    case "invoices.list":
    case "reports.summary":
    case "notifications.list":
    case "compliance.review":
    case "commerce.search":
    case "payments.debtors":
    case "receipt.review":
    case "receipt.lookup":
    case "receipt.list":
    case "contacts.search":
    case "purchase.history":
    case "sales.history":
    case "route.history":
    case "unknown.clarify":
    case "computer.observe":
    case "computer.scroll":
    case "computer.control.take":
    case "computer.control.release":
    case "computer.checkpoint":
    case "computer.suspend":
    case "computer.close":
      return valid();

    case "computer.session.create":
    case "computer.session.resume": {
      const profileId = input.profileId;
      if (profileId !== undefined && typeof profileId !== "string")
        return invalid("Computer profile id must be a string when provided.");
      if (
        input.externalSurfaceType !== undefined &&
        !["web", "pwa", "desktop", "mobile-web"].includes(String(input.externalSurfaceType))
      )
        return invalid("External surface type must be web, pwa, desktop, or mobile-web.");
      return valid();
    }

    case "computer.navigate": {
      const url = typeof input.url === "string" ? input.url.trim() : "";
      if (url.length === 0) return invalid("Which website should I open?");
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" || parsed.protocol === "http:"
          ? valid()
          : invalid("Computer navigation only supports http and https URLs.");
      } catch {
        return invalid("Computer navigation needs a valid URL.");
      }
    }

    case "computer.click": {
      const hasSelector = typeof input.selector === "string" && input.selector.trim().length > 0;
      const hasText = typeof input.text === "string" && input.text.trim().length > 0;
      return hasSelector || hasText
        ? valid()
        : invalid("Computer click needs a selector or visible target text.");
    }

    case "computer.type": {
      const text = typeof input.text === "string" ? input.text : "";
      return text.length > 0 && text.length <= 4000
        ? valid()
        : invalid("Computer typing needs text between 1 and 4000 characters.");
    }

    case "computer.upload": {
      const fileRef = typeof input.fileRef === "string" ? input.fileRef.trim() : "";
      return fileRef.length > 0
        ? valid()
        : invalid("Computer upload needs a trusted file reference.");
    }

    case "network.route":
      return typeof input.requestText === "string" && input.requestText.trim().length > 0
        ? valid()
        : invalid("What should I look for through your network?");

    case "network.contacts.resolve":
      return typeof input.query === "string" && input.query.trim().length > 0
        ? valid()
        : invalid("Who should I look up in your contacts?");

    case "network.identity.list":
      return valid();

    case "network.identity.propose": {
      const errors: string[] = [];
      if (typeof input.provider !== "string" || input.provider.trim().length === 0) {
        errors.push("Which provider was this identity observed on?");
      }
      if (typeof input.providerSubject !== "string" || input.providerSubject.trim().length === 0) {
        errors.push("What is the observed provider identifier?");
      }
      if (typeof input.displayName !== "string" || input.displayName.trim().length === 0) {
        errors.push("What name was observed for this identity?");
      }
      if (typeof input.evidence !== "string" || input.evidence.trim().length === 0) {
        errors.push("What evidence supports this observed identity?");
      }
      return errors.length === 0 ? valid() : invalid(...errors);
    }

    case "network.identity.confirm":
      return typeof input.candidateId === "string" && input.candidateId.trim().length > 0
        ? valid()
        : invalid("Which identity candidate should I confirm?");

    case "network.identity.reject":
      return typeof input.candidateId === "string" && input.candidateId.trim().length > 0
        ? valid()
        : invalid("Which identity candidate should I reject?");

    case "network.identity.unlink":
      return typeof input.nodeId === "string" &&
        input.nodeId.trim().length > 0 &&
        typeof input.externalIdentityId === "string" &&
        input.externalIdentityId.trim().length > 0
        ? valid()
        : invalid("Which contact and identity should I unlink?");

    case "network.identity.add": {
      const errors: string[] = [];
      if (typeof input.nodeId !== "string" || input.nodeId.trim().length === 0) {
        errors.push("Which contact should I add this identity to?");
      }
      if (typeof input.provider !== "string" || input.provider.trim().length === 0) {
        errors.push("Which provider is this identity on?");
      }
      if (typeof input.providerSubject !== "string" || input.providerSubject.trim().length === 0) {
        errors.push("What is the identity's provider identifier or handle?");
      }
      return errors.length === 0 ? valid() : invalid(...errors);
    }

    case "commerce.checkout": {
      const items = Array.isArray(input.items) ? input.items : [];
      const errors: string[] = [];
      if (items.length === 0 || items.length > 100) {
        errors.push("Checkout needs between one and 100 canonical buy-feed items.");
      }
      for (const [index, item] of items.entries()) {
        const record =
          item !== null && typeof item === "object" ? (item as Record<string, unknown>) : null;
        if (
          record === null ||
          !["catalogue", "contact", "marketplace_connector"].includes(String(record.sourceKind)) ||
          typeof record.sourceId !== "string" ||
          record.sourceId.trim().length === 0 ||
          typeof record.sourceLabel !== "string" ||
          record.sourceLabel.trim().length === 0 ||
          typeof record.title !== "string" ||
          record.title.trim().length === 0 ||
          typeof record.quantity !== "number" ||
          !Number.isInteger(record.quantity) ||
          record.quantity < 1
        ) {
          errors.push(`Checkout item ${index + 1} is not a canonical buy-feed item.`);
        }
      }
      return errors.length === 0 ? valid() : invalid(...errors);
    }

    case "receipt.scan": {
      const extractedText =
        typeof input.extractedText === "string" ? input.extractedText.trim() : "";
      return extractedText.length > 0
        ? valid()
        : invalid("Attach a receipt and provide its trusted OCR text before I scan it.");
    }

    case "receipt.confirm":
      return typeof input.ocrJobId === "string" && input.ocrJobId.trim().length > 0
        ? valid()
        : invalid("Which receipt scan should I confirm?");

    case "receipt.correct": {
      const ocrJobId = typeof input.ocrJobId === "string" ? input.ocrJobId.trim() : "";
      const extractedText =
        typeof input.extractedText === "string" ? input.extractedText.trim() : "";
      const errors: string[] = [];
      if (ocrJobId.length === 0) errors.push("Which receipt scan should I correct?");
      if (extractedText.length === 0) errors.push("What should the corrected receipt text be?");
      return errors.length === 0 ? valid() : invalid(...errors);
    }

    case "receipt.cancel":
      return typeof input.ocrJobId === "string" && input.ocrJobId.trim().length > 0
        ? valid()
        : invalid("Which receipt scan should I cancel?");

    case "document_import.confirm":
      return typeof input.importJobId === "string" && input.importJobId.trim().length > 0
        ? valid()
        : invalid("Which document import should I add?");

    case "workspace.deliver": {
      const pathIsValid = typeof input.path === "string" && input.path.trim().length > 0;
      const additionalPathsAreValid =
        input.additionalPaths === undefined ||
        (Array.isArray(input.additionalPaths) &&
          input.additionalPaths.length <= 9 &&
          input.additionalPaths.every(
            (path) => typeof path === "string" && path.trim().length > 0
          ));
      return pathIsValid && additionalPathsAreValid
        ? valid()
        : invalid("Choose between one and ten workspace files to deliver.");
    }

    case "messaging.send": {
      const text = typeof input.text === "string" ? input.text.trim() : "";
      const customerId = typeof input.customerId === "string" ? input.customerId.trim() : "";
      const conversationId =
        typeof input.conversationId === "string" ? input.conversationId.trim() : "";
      const customerName = typeof input.customerName === "string" ? input.customerName.trim() : "";
      const provider = typeof input.provider === "string" ? input.provider.trim() : "";
      const subject = typeof input.subject === "string" ? input.subject.trim() : "";
      const errors: string[] = [];
      if (
        input.provider !== undefined &&
        (typeof input.provider !== "string" ||
          ![
            "grogoni",
            "telegram",
            "whatsapp",
            "messenger",
            "instagram",
            "tiktok",
            "x",
            "sms",
            "native_sms",
            "email"
          ].includes(input.provider))
      ) {
        errors.push("Choose a supported messaging provider; the route will not be substituted.");
      }
      if (text.length === 0 || text.length > 4000) {
        errors.push("A message between 1 and 4000 characters is required.");
      }
      if (customerId === "" && conversationId === "" && customerName === "") {
        errors.push("Choose a canonical customer or conversation before sending.");
      }
      if (provider === "email" && (subject.length === 0 || subject.length > 200)) {
        errors.push("Email requires a subject between 1 and 200 characters.");
      }
      if (input.attachments !== undefined) {
        if (!Array.isArray(input.attachments) || input.attachments.length > 3) {
          errors.push("Email supports at most three trusted attachment references.");
        } else if (
          input.attachments.some(
            (attachment) =>
              attachment === null ||
              typeof attachment !== "object" ||
              (attachment as Record<string, unknown>).resourceType !== "invoice" ||
              typeof (attachment as Record<string, unknown>).resourceId !== "string"
          )
        ) {
          errors.push("Email attachments must reference trusted invoice resources.");
        }
      }
      return errors.length === 0 ? valid() : invalid(...errors);
    }

    case "product.create": {
      const errors: string[] = [];
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const unit = typeof input.unit === "string" ? input.unit.trim() : "";
      const quantity = Number(input.quantity ?? 0);

      if (name.length === 0) {
        errors.push("Product name is required before a product can be drafted.");
      }

      if (unit.length === 0) {
        errors.push("Product unit is required before a product can be drafted.");
      }

      if (!Number.isFinite(quantity) || quantity < 0) {
        errors.push("Product quantity must be a non-negative number.");
      }

      return errors.length === 0 ? valid() : invalid(...errors);
    }

    case "product.update": {
      const productName = typeof input.productName === "string" ? input.productName.trim() : "";
      const errors: string[] = [];

      if (productName.length === 0) {
        errors.push("Which product should I edit?");
      }

      const changedFields = ["name", "unit", "quantity", "buyingPrice", "sellingPrice"].filter(
        (field) => input[field] !== undefined
      );
      if (changedFields.length === 0) {
        errors.push("Which product details should I change?");
      }
      for (const field of ["quantity", "buyingPrice", "sellingPrice"] as const) {
        if (
          input[field] !== undefined &&
          (typeof input[field] !== "number" || !Number.isFinite(input[field]) || input[field] < 0)
        ) {
          errors.push(`${field} must be a non-negative number.`);
        }
      }

      return errors.length === 0 ? valid() : invalid(...errors);
    }

    case "product.delete": {
      const productName = typeof input.productName === "string" ? input.productName.trim() : "";
      const productIds = Array.isArray(input.productIds) ? input.productIds : [];

      return productName.length === 0 && productIds.length === 0
        ? invalid("Which product should I delete?")
        : valid();
    }

    case "product.stock_adjust": {
      const productName = typeof input.productName === "string" ? input.productName.trim() : "";
      const quantity = Number(input.quantity);
      const errors: string[] = [];

      if (productName.length === 0) {
        errors.push("Which product stock should I adjust?");
      }

      if (!Number.isFinite(quantity)) {
        errors.push("What quantity change should I apply?");
      }

      return errors.length === 0 ? valid() : invalid(...errors);
    }

    case "product.field.add": {
      const fieldName = typeof input.fieldName === "string" ? input.fieldName.trim() : "";
      const supportedTypes = ["text", "number", "select", "textarea", "yes_no"];
      const errors: string[] = [];
      if (fieldName.length === 0) errors.push("Which product field should I add?");
      if (input.inputType !== undefined && !supportedTypes.includes(String(input.inputType))) {
        errors.push("Product field type must be text, number, select, textarea, or yes_no.");
      }

      return errors.length === 0 ? valid() : invalid(...errors);
    }

    case "product.field.remove": {
      const fieldName = typeof input.fieldName === "string" ? input.fieldName.trim() : "";

      return fieldName.length === 0 ? invalid("Which product field should I remove?") : valid();
    }

    case "customer.create": {
      const name = typeof input.name === "string" ? input.name.trim() : "";

      return name.length === 0
        ? invalid("Customer name is required before a customer can be drafted.")
        : valid();
    }

    case "customer.update": {
      const customerName = typeof input.customerName === "string" ? input.customerName.trim() : "";

      return customerName.length === 0 ? invalid("Which customer should I edit?") : valid();
    }

    case "supplier.create": {
      const name = typeof input.name === "string" ? input.name.trim() : "";

      return name.length === 0
        ? invalid("Supplier name is required before a supplier can be drafted.")
        : valid();
    }

    case "supplier.update": {
      const supplierName = typeof input.supplierName === "string" ? input.supplierName.trim() : "";

      return supplierName.length === 0 ? invalid("Which supplier should I edit?") : valid();
    }

    case "supplier.contact.attach":
      return requiredStrings(
        input,
        ["supplierId", "contactId", "role"],
        "Choose a supplier, contact, and role."
      );

    case "purchase.price.change": {
      const ids = requiredStrings(
        input,
        ["productId"],
        "Choose a product before changing its buying price."
      );
      if (!ids.ok) return ids;
      return typeof input.price === "number" && Number.isFinite(input.price) && input.price >= 0
        ? valid()
        : invalid("Buying price must be a non-negative number.");
    }

    case "purchase.record": {
      const ids = requiredStrings(
        input,
        ["supplierId", "productId"],
        "Choose a supplier and product."
      );
      if (!ids.ok) return ids;
      return typeof input.quantity === "number" &&
        input.quantity > 0 &&
        typeof input.buyingPrice === "number" &&
        input.buyingPrice >= 0
        ? valid()
        : invalid("Purchase quantity must be positive and buying price non-negative.");
    }

    case "sale.record":
      return Array.isArray(input.items) && input.items.length > 0
        ? valid()
        : invalid("Add at least one product to the sale.");

    case "route.record":
      return input.origin !== null &&
        typeof input.origin === "object" &&
        input.destination !== null &&
        typeof input.destination === "object"
        ? valid()
        : invalid("Route origin and destination are required.");

    case "invoice.draft": {
      const customerId = typeof input.customerId === "string" ? input.customerId.trim() : "";
      const customerName = typeof input.customerName === "string" ? input.customerName.trim() : "";
      const items = Array.isArray(input.items) ? input.items : [];
      const errors: string[] = [];
      if (customerId.length === 0 && customerName.length === 0) {
        errors.push("Which customer should receive the invoice?");
      }
      if (items.length === 0) {
        errors.push("Add at least one invoice item with a product, quantity, and unit price.");
      } else {
        for (const [index, item] of items.entries()) {
          const record =
            item !== null && typeof item === "object" ? (item as Record<string, unknown>) : null;
          if (
            record === null ||
            typeof record.productId !== "string" ||
            record.productId.trim().length === 0 ||
            typeof record.quantity !== "number" ||
            !Number.isFinite(record.quantity) ||
            record.quantity <= 0 ||
            typeof record.unitPrice !== "number" ||
            !Number.isFinite(record.unitPrice) ||
            record.unitPrice < 0
          ) {
            errors.push(
              `Invoice item ${index + 1} needs a productId, positive quantity, and non-negative unitPrice.`
            );
          }
        }
      }
      return errors.length === 0 ? valid() : invalid(...errors);
    }

    case "payment.record": {
      const invoiceId = typeof input.invoiceId === "string" ? input.invoiceId.trim() : "";
      const methods = [
        "cash",
        "bank_transfer",
        "mobile_money_manual",
        "card_manual",
        "other_manual"
      ];
      const errors: string[] = [];
      if (invoiceId.length === 0)
        errors.push("Which confirmed invoice should receive the payment?");
      if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount <= 0) {
        errors.push("Payment amount must be a positive number.");
      }
      if (!methods.includes(String(input.method))) {
        errors.push("Choose a supported payment method.");
      }
      return errors.length === 0 ? valid() : invalid(...errors);
    }

    case "logistics.update_status":
      return typeof input.logisticsId === "string" &&
        input.logisticsId.trim().length > 0 &&
        typeof input.status === "string" &&
        input.status.trim().length > 0
        ? valid()
        : invalid("Logistics runtime draft needs which delivery and the new status.");
  }
}

function requiredStrings(
  input: Record<string, unknown>,
  fields: string[],
  message: string
): ValidationResult {
  return fields.every(
    (field) => typeof input[field] === "string" && String(input[field]).trim().length > 0
  )
    ? valid()
    : invalid(message);
}
