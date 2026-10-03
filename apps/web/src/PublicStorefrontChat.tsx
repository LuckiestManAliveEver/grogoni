import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { Surface } from "@grogoni/ui";

import { routes } from "./routes";
import { navigateToBrowserUrl } from "./browser-navigation";

import { useAsyncActions } from "./hooks/useAsyncActions";

import { AuthenticationActionMessage } from "./AuthenticationActionMessage";

import {
  type PublicCustomerCareRequestResponse,
  type PublicOrderResponse,
  type PublicStorefrontMessageResponse,
  type PublicStorefrontProductSummary,
  type PublicStorefrontSessionResponse,
  type PublicStorefrontSummary,
  type StorefrontCareRequestType,
  type StorefrontCartItem,
  type StorefrontChatMessage,
  type StorefrontCheckoutDetails,
  type StorefrontCrmNote,
  chatAttachmentAccept
} from "./grogoni-application-shared";

import { postJson, getJson } from "./api-helpers";
import { formatMoney, formatCareRequestType } from "./formatters";
import { createStorefrontUrl } from "./grogoniid-and-storefront";

import { findBestByName, hasUseVerb } from "./agent-command-engine";
import { startVoiceInput, getErrorMessage } from "./chat-message-plumbing";

import { useInstallPrompt } from "./misc-browser-utils";

import { BuildIdentity } from "./BuildIdentity";

export function PublicStorefrontChat(props: { agentId: string; productId?: string | null }) {
  const installPrompt = useInstallPrompt();
  const { isPending, runAction } = useAsyncActions();
  const [visitorId] = useState(readStorefrontVisitorId);
  const [capabilityToken, setCapabilityToken] = useState("");
  const [storefront, setStorefront] = useState<PublicStorefrontSummary | null>(null);
  const [messages, setMessages] = useState<StorefrontChatMessage[]>([]);
  const [cart, setCart] = useState<StorefrontCartItem[]>([]);
  const [crmNotes, setCrmNotes] = useState<StorefrontCrmNote[]>([]);
  const [draft, setDraft] = useState("");
  const [receiptProductId, setReceiptProductId] = useState("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [careNotesOpen, setCareNotesOpen] = useState(true);
  const [careRequestType, setCareRequestType] = useState<StorefrontCareRequestType | null>(null);
  const [checkoutDetails, setCheckoutDetails] = useState<StorefrontCheckoutDetails>({
    name: "",
    phone: "",
    note: ""
  });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const storefrontFileInputRef = useRef<HTMLInputElement | null>(null);
  const openedProductInAppRef = useRef(false);

  useEffect(() => {
    let isActive = true;

    setStatus("loading");
    setError("");
    Promise.all([
      getJson<PublicStorefrontSummary>(`/public/storefronts/${encodeURIComponent(props.agentId)}`),
      postJson<PublicStorefrontSessionResponse>(
        `/public/storefronts/${encodeURIComponent(props.agentId)}/sessions`,
        { visitorId, displayName: null }
      )
    ])
      .then(([nextStorefront, session]) => {
        if (!isActive) {
          return;
        }

        setStorefront(nextStorefront);
        setCapabilityToken(session.capabilityToken);
        setStatus("ready");
      })
      .catch((caught: unknown) => {
        if (!isActive) {
          return;
        }

        setError(getErrorMessage(caught));
        setStatus("error");
      });

    return () => {
      isActive = false;
    };
  }, [props.agentId, visitorId]);

  const products = storefront?.products ?? [];
  const activeProduct =
    props.productId === null || props.productId === undefined
      ? null
      : (products.find((product) => product.id === props.productId) ?? null);
  const availableProducts = products.filter((product) => product.available);
  const firstAvailableProductId = products.find((product) => product.available)?.id ?? "";
  const receiptProductMissing =
    receiptProductId.length > 0 &&
    products.every((product) => product.id !== receiptProductId || !product.available);
  const cartCount = cart.reduce((total, item) => total + item.quantity, 0);
  const cartProducts = cart
    .map((item) => {
      const product = products.find((candidate) => candidate.id === item.productId);
      return product === undefined ? null : { ...product, quantity: item.quantity };
    })
    .filter((item): item is PublicStorefrontProductSummary & { quantity: number } => item !== null);
  const storefrontCardOpen =
    receiptOpen || cartProducts.length > 0 || checkoutOpen || careRequestType !== null;

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const messageList = messageListRef.current;

      if (messageList === null) {
        return;
      }

      messageList.scrollTo({
        top: messageList.scrollHeight,
        behavior: "smooth"
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [
    messages.length,
    cartProducts.length,
    checkoutOpen,
    receiptOpen,
    crmNotes.length,
    catalogueOpen,
    careNotesOpen
  ]);

  useEffect(() => {
    if (receiptProductId.length === 0 || receiptProductMissing) {
      setReceiptProductId(firstAvailableProductId);
    }
  }, [firstAvailableProductId, receiptProductId, receiptProductMissing]);

  useEffect(() => {
    if (props.productId !== null && props.productId !== undefined) {
      setCatalogueOpen(true);
    }
  }, [props.productId]);

  function openStorefrontProduct(product: PublicStorefrontProductSummary) {
    openedProductInAppRef.current = true;
    setCatalogueOpen(true);
    navigateToBrowserUrl(routes.storefrontProduct(props.agentId, product.id));
  }

  function closeStorefrontProduct() {
    if (openedProductInAppRef.current) {
      openedProductInAppRef.current = false;
      window.history.back();
      return;
    }
    navigateToBrowserUrl(routes.publicAgent(props.agentId), { replace: true });
  }

  function appendMessage(author: StorefrontChatMessage["author"], body: string) {
    setMessages((currentMessages) => [
      ...currentMessages,
      {
        id: `${author}-${Date.now()}-${currentMessages.length}`,
        author,
        body
      }
    ]);
  }

  function addCrmNote(label: string, body: string) {
    setCareNotesOpen(true);
    setCrmNotes((notes) => [
      ...notes,
      {
        id: `crm-${Date.now()}-${notes.length}`,
        label,
        body
      }
    ]);
  }

  function requestCallback() {
    appendMessage("customer", "I would like a callback.");
    setCareRequestType("callback");
    appendMessage("agent", "Add your name and phone number so I can send the callback request.");
  }

  function requestVoiceInput() {
    startVoiceInput(setDraft);
  }

  function handleStorefrontAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (files.length === 0) {
      return;
    }

    const attachmentNames = files.slice(0, 10).map((file) => file.name);
    const names = attachmentNames.join(", ");
    void runAction("storefront-attachment", async () => {
      try {
        await postJson<PublicStorefrontMessageResponse>(
          `/public/storefronts/${encodeURIComponent(props.agentId)}/messages`,
          { capabilityToken, body: `Attachment references: ${names}`, attachmentNames }
        );
        appendMessage("customer", `Shared ${names}`);
        appendMessage(
          "agent",
          "The store received the attachment names with your message. File contents are not uploaded in this version."
        );
      } catch (caught) {
        appendMessage("agent", getErrorMessage(caught));
      }
    });
  }

  function requestQuote() {
    if (cartCount === 0) {
      appendMessage(
        "agent",
        "Add the products you are interested in first, then I can prepare a quote request."
      );
      return;
    }

    appendMessage("customer", "Please prepare a quote.");
    setCareRequestType("quote");
    appendMessage("agent", "Add your contact details and I will send the quote request.");
  }

  function requestSupport() {
    appendMessage("customer", "I need customer support.");
    setCareRequestType("support");
    appendMessage("agent", "Describe what you need and I will send it to customer care.");
  }

  function registerNewCustomerByAgent() {
    if (storefront === null) {
      return;
    }

    appendMessage("customer", "Help me register someone new.");
    setCareRequestType("registration");
    appendMessage(
      "agent",
      `Add their contact details or share ${storefront.commerceAddress} with them.`
    );
  }

  function addProductToCart(product: PublicStorefrontProductSummary) {
    setCart((currentCart) => {
      const existing = currentCart.find((item) => item.productId === product.id);

      if (existing === undefined) {
        return [...currentCart, { productId: product.id, quantity: 1 }];
      }

      return currentCart.map((item) =>
        item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item
      );
    });
    appendMessage("customer", `Add ${product.name} to my order.`);
    appendMessage(
      "agent",
      `${product.name} is in your order. I will ask for your contact details only when you check out.`
    );
  }

  function addReceiptProduct() {
    const product = availableProducts.find((item) => item.id === receiptProductId);

    if (product === undefined) {
      return;
    }

    addProductToCart(product);
    setReceiptOpen(true);
  }

  function updateCartQuantity(productId: string, quantity: number) {
    setCart((currentCart) =>
      quantity <= 0
        ? currentCart.filter((item) => item.productId !== productId)
        : currentCart.map((item) => (item.productId === productId ? { ...item, quantity } : item))
    );
  }

  function removeCartItem(productId: string) {
    setCart((currentCart) => currentCart.filter((item) => item.productId !== productId));
  }

  async function handleDraftSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (storefrontCardOpen) {
      return;
    }

    const message = draft.trim();

    if (message.length === 0) {
      return;
    }

    const persisted = await runAction("storefront-message", async () => {
      try {
        return await postJson<PublicStorefrontMessageResponse>(
          `/public/storefronts/${encodeURIComponent(props.agentId)}/messages`,
          { capabilityToken, body: message, attachmentNames: [] }
        );
      } catch (caught) {
        appendMessage("agent", getErrorMessage(caught));
        return null;
      }
    });
    if (persisted == null) return;
    setDraft("");
    appendMessage("customer", message);

    const lowerMessage = message.toLowerCase();
    const matchedProduct = findBestPublicProduct(message, availableProducts);

    if (matchedProduct !== null && hasUseVerb(message)) {
      setCart((currentCart) => {
        const existing = currentCart.find((item) => item.productId === matchedProduct.id);

        if (existing === undefined) {
          return [...currentCart, { productId: matchedProduct.id, quantity: 1 }];
        }

        return currentCart.map((item) =>
          item.productId === matchedProduct.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      });
      appendMessage(
        "agent",
        `${matchedProduct.name} is in your order. Resend checkout when you are ready to finish.`
      );
      addCrmNote("Product interest", `Customer added ${matchedProduct.name} from chat.`);
      return;
    }

    if (matchedProduct !== null) {
      appendMessage(
        "agent",
        `I found ${matchedProduct.name}. Resend with an action, for example: add ${matchedProduct.name} to my order.`
      );
      return;
    }

    if (lowerMessage.includes("checkout") || lowerMessage.includes("order")) {
      if (cartCount === 0) {
        appendMessage("agent", "Choose at least one product first, then I can help you check out.");
        return;
      }

      setCheckoutOpen(true);
      appendMessage("agent", "I can prepare checkout now. Please add your details below.");
      return;
    }

    if (
      lowerMessage.includes("quote") ||
      lowerMessage.includes("price") ||
      lowerMessage.includes("estimate")
    ) {
      requestQuote();
      return;
    }

    if (
      lowerMessage.includes("support") ||
      lowerMessage.includes("help") ||
      lowerMessage.includes("complaint") ||
      lowerMessage.includes("return") ||
      lowerMessage.includes("refund") ||
      lowerMessage.includes("delivery")
    ) {
      requestSupport();
      return;
    }

    if (
      lowerMessage.includes("call") ||
      lowerMessage.includes("contact me") ||
      lowerMessage.includes("follow up")
    ) {
      requestCallback();
      return;
    }

    if (
      lowerMessage.includes("product") ||
      lowerMessage.includes("list") ||
      lowerMessage.includes("browse")
    ) {
      setCatalogueOpen(true);
      appendMessage(
        "agent",
        products.length === 0
          ? "There are no available products listed right now."
          : `I found ${products.length} available product${products.length === 1 ? "" : "s"}. Use the product list above to add items.`
      );
      return;
    }

    appendMessage(
      "agent",
      "I can help you browse products and prepare checkout. Pick an item above or ask for the product list."
    );
  }

  async function handleCheckoutSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (
      cartCount === 0 ||
      checkoutDetails.name.trim() === "" ||
      checkoutDetails.phone.trim() === ""
    ) {
      appendMessage(
        "agent",
        "I need your name, phone number, and at least one product to prepare checkout."
      );
      return;
    }

    await runAction("storefront-order", async () => {
      try {
        const order = await postJson<PublicOrderResponse>(
          `/public/storefronts/${encodeURIComponent(props.agentId)}/orders`,
          {
            capabilityToken,
            customerName: checkoutDetails.name.trim(),
            phone: checkoutDetails.phone.trim(),
            note: checkoutDetails.note.trim() || null,
            items: cartProducts.map((product) => ({
              productId: product.id,
              quantity: product.quantity
            }))
          }
        );
        setCheckoutOpen(false);
        setCart([]);
        appendMessage(
          "agent",
          `Order ${order.id.slice(0, 8)} was sent to the store with status ${order.status}.`
        );
        addCrmNote("Order request", `Order ${order.id} was sent to the store.`);
      } catch (caught) {
        appendMessage("agent", getErrorMessage(caught));
      }
    });
  }

  async function handleCareRequestSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (careRequestType === null) return;
    const phone = checkoutDetails.phone.trim();
    if (careRequestType === "callback" && phone === "") {
      appendMessage("agent", "A phone number is required for a callback.");
      return;
    }
    await runAction("storefront-care", async () => {
      try {
        const itemSummary = cartProducts
          .map((product) => `${product.quantity} × ${product.name}`)
          .join(", ");
        const request = await postJson<PublicCustomerCareRequestResponse>(
          `/public/storefronts/${encodeURIComponent(props.agentId)}/customer-care`,
          {
            type: careRequestType,
            customerName: checkoutDetails.name.trim() || null,
            phone: phone || null,
            message: [checkoutDetails.note.trim(), itemSummary].filter(Boolean).join(" · ") || null
          }
        );
        appendMessage(
          "agent",
          `${formatCareRequestType(request.type)} request ${request.id.slice(0, 8)} was sent to the store.`
        );
        addCrmNote("Customer care", `${formatCareRequestType(request.type)} request sent.`);
        setCareRequestType(null);
      } catch (caught) {
        appendMessage("agent", getErrorMessage(caught));
      }
    });
  }

  if (status === "loading") {
    return (
      <Surface title="Grogoni">
        <main className="public-storefront-shell">
          <section className="public-chat-panel">
            <div className="message grogoniclaw">
              <span>Agent</span>
              <p>Loading storefront...</p>
            </div>
          </section>
        </main>
      </Surface>
    );
  }

  if (status === "error" || storefront === null) {
    return (
      <Surface title="Grogoni">
        <main className="public-storefront-shell">
          <section className="public-chat-panel">
            <div className="message grogoniclaw">
              <span>Agent</span>
              <p>
                <AuthenticationActionMessage message={error || "Storefront was not found."} />
              </p>
            </div>
          </section>
        </main>
      </Surface>
    );
  }

  const storefrontUrl = createStorefrontUrl(storefront.grogoniId);

  return (
    <Surface title={`${storefront.businessName} storefront`}>
      <main className="public-storefront-shell">
        <section className="public-chat-panel" aria-label="Storefront chat">
          <div className="public-chat-header">
            <span className="agent-avatar">S</span>
            <div>
              <strong>{storefront.businessName}</strong>
              <span>
                {storefront.commerceAddress} · {storefront.presence.status}
              </span>
            </div>
            <div className="public-chat-actions">
              {installPrompt.canInstall ? (
                <button
                  className="header-action-button workspace"
                  type="button"
                  onClick={() => void installPrompt.installApp()}
                >
                  Install
                </button>
              ) : null}
              <button
                className="header-action-button"
                type="button"
                onClick={() => setCatalogueOpen((current) => !current)}
              >
                Catalogue
              </button>
              <button
                className="header-action-button"
                type="button"
                onClick={() => setReceiptOpen((current) => !current)}
              >
                Receipt {cartCount > 0 ? cartCount : ""}
              </button>
              <details className="customer-care-menu">
                <summary className="header-signout-button">Customer care</summary>
                <div className="customer-care-dropdown">
                  <button type="button" onClick={requestCallback}>
                    Request callback
                  </button>
                  <button type="button" onClick={requestQuote}>
                    Request quote
                  </button>
                  <button type="button" onClick={requestSupport}>
                    Support
                  </button>
                  <button type="button" onClick={registerNewCustomerByAgent}>
                    Register customer
                  </button>
                </div>
              </details>
            </div>
          </div>

          <div className="public-message-list" ref={messageListRef}>
            <div className="message grogoniclaw">
              <span>Agent</span>
              <p>
                Karibu to {storefront.businessName}. I can help you browse products and prepare
                checkout when you are ready. Use {storefront.commerceAddress} any time you want to
                return to this shop. Open Catalogue to browse without leaving the conversation.
              </p>
            </div>

            {activeProduct !== null ? (
              <section className="storefront-product-card" aria-label="Product details">
                {activeProduct.image === null ? null : (
                  <img src={activeProduct.image} alt={activeProduct.name} loading="lazy" />
                )}
                <div className="storefront-card-header">
                  <div>
                    <span>Product</span>
                    <strong>{activeProduct.name}</strong>
                  </div>
                  <button className="secondary" type="button" onClick={closeStorefrontProduct}>
                    Back
                  </button>
                </div>
                <p>
                  Sold by {storefront.businessName} · {activeProduct.unit} ·{" "}
                  {activeProduct.sellingPrice === null
                    ? "Ask for price"
                    : formatMoney(activeProduct.sellingPrice)}
                </p>
                <button type="button" onClick={() => addProductToCart(activeProduct)}>
                  Add to receipt
                </button>
              </section>
            ) : props.productId !== null && props.productId !== undefined ? (
              <section className="storefront-product-card" aria-label="Product unavailable">
                <div className="storefront-card-header">
                  <strong>Product unavailable</strong>
                  <button className="secondary" type="button" onClick={closeStorefrontProduct}>
                    Back to catalogue
                  </button>
                </div>
              </section>
            ) : null}

            {catalogueOpen ? (
              <section className="storefront-product-card" aria-label="Product list">
                <div className="storefront-card-header">
                  <div>
                    <span>Catalogue</span>
                    <strong>
                      {products.length === 0 ? "No products listed" : "Swipe products"}
                    </strong>
                  </div>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setCatalogueOpen(false)}
                  >
                    Close
                  </button>
                </div>
                <div className="storefront-product-grid">
                  {products.length === 0 ? (
                    <p>No products are available right now.</p>
                  ) : (
                    products.map((product) => (
                      <article key={product.id} className="storefront-product-tile">
                        {product.image === null ? null : (
                          <img src={product.image} alt={product.name} loading="lazy" />
                        )}
                        <div>
                          <strong>{product.name}</strong>
                          <span>
                            {product.unit} ·{" "}
                            {product.sellingPrice === null
                              ? "Ask for price"
                              : formatMoney(product.sellingPrice)}
                          </span>
                        </div>
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => openStorefrontProduct(product)}
                        >
                          View
                        </button>
                        <button type="button" onClick={() => addProductToCart(product)}>
                          Add
                        </button>
                      </article>
                    ))
                  )}
                </div>
              </section>
            ) : null}

            {receiptOpen ? (
              <section className="storefront-receipt" aria-label="Receipt">
                <div className="storefront-card-header">
                  <div>
                    <span>Receipt</span>
                    <strong>
                      {cartCount} item{cartCount === 1 ? "" : "s"}
                    </strong>
                  </div>
                  <button className="secondary" type="button" onClick={() => setReceiptOpen(false)}>
                    Close
                  </button>
                </div>
                {cartProducts.length === 0 ? (
                  <p>No purchases selected yet. Add products to build a receipt.</p>
                ) : (
                  <div className="storefront-receipt-lines">
                    {cartProducts.map((product) => (
                      <div key={product.id}>
                        <span>{product.name}</span>
                        <input
                          aria-label={`${product.name} receipt quantity`}
                          min="0"
                          inputMode="numeric"
                          type="number"
                          value={product.quantity}
                          onChange={(event) =>
                            updateCartQuantity(
                              product.id,
                              Number.parseInt(event.target.value, 10) || 0
                            )
                          }
                        />
                        <button type="button" onClick={() => removeCartItem(product.id)}>
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="storefront-receipt-add">
                  <select
                    aria-label="Add receipt item"
                    value={receiptProductId}
                    onChange={(event) => setReceiptProductId(event.target.value)}
                  >
                    {availableProducts.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={addReceiptProduct}
                    disabled={receiptProductId === ""}
                  >
                    Add item
                  </button>
                </div>
                <p>Storefront: {storefrontUrl}</p>
              </section>
            ) : null}

            {cartProducts.length > 0 ? (
              <section className="storefront-cart-summary" aria-label="Cart">
                <div className="storefront-card-header">
                  <div>
                    <span>Order</span>
                    <strong>
                      {cartCount} item{cartCount === 1 ? "" : "s"}
                    </strong>
                  </div>
                  <button className="secondary" type="button" onClick={() => setCart([])}>
                    Close
                  </button>
                </div>
                <div className="storefront-cart-lines">
                  {cartProducts.map((product) => (
                    <div key={product.id}>
                      <span>{product.name}</span>
                      <input
                        aria-label={`${product.name} quantity`}
                        min="0"
                        inputMode="numeric"
                        type="number"
                        value={product.quantity}
                        onChange={(event) =>
                          updateCartQuantity(
                            product.id,
                            Number.parseInt(event.target.value, 10) || 0
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
                <button type="button" onClick={() => setCheckoutOpen(true)}>
                  Checkout
                </button>
              </section>
            ) : null}

            {crmNotes.length > 0 && careNotesOpen ? (
              <section className="storefront-crm-card" aria-label="Customer care notes">
                <div className="storefront-card-header">
                  <div>
                    <span>Customer care</span>
                    <strong>Conversation and follow-up</strong>
                  </div>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setCareNotesOpen(false)}
                  >
                    Close
                  </button>
                </div>
                <div className="storefront-crm-notes" aria-label="Conversation notes">
                  {crmNotes.slice(-3).map((note) => (
                    <p key={note.id}>
                      <strong>{note.label}</strong>
                      <span>{note.body}</span>
                    </p>
                  ))}
                </div>
              </section>
            ) : null}

            {messages.map((message) => (
              <div
                key={message.id}
                className={`message ${message.author === "agent" ? "grogoniclaw" : "merchant"}`}
              >
                <span>{message.author === "agent" ? "Agent" : "You"}</span>
                <p>
                  {message.author === "agent" ? (
                    <AuthenticationActionMessage message={message.body} />
                  ) : (
                    message.body
                  )}
                </p>
              </div>
            ))}

            {careRequestType !== null ? (
              <form className="storefront-checkout" onSubmit={handleCareRequestSubmit}>
                <div className="storefront-card-header">
                  <div className="section-heading">
                    <p className="eyebrow">Customer care</p>
                    <h3>{formatCareRequestType(careRequestType)} request</h3>
                  </div>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setCareRequestType(null)}
                    disabled={isPending("storefront-care")}
                  >
                    Close
                  </button>
                </div>
                <label>
                  Name
                  <input
                    value={checkoutDetails.name}
                    onChange={(event) =>
                      setCheckoutDetails({ ...checkoutDetails, name: event.target.value })
                    }
                  />
                </label>
                <label>
                  Phone {careRequestType === "callback" ? "(required)" : "(optional)"}
                  <input
                    value={checkoutDetails.phone}
                    inputMode="tel"
                    required={careRequestType === "callback"}
                    onChange={(event) =>
                      setCheckoutDetails({ ...checkoutDetails, phone: event.target.value })
                    }
                  />
                </label>
                <label>
                  Details
                  <textarea
                    value={checkoutDetails.note}
                    onChange={(event) =>
                      setCheckoutDetails({ ...checkoutDetails, note: event.target.value })
                    }
                    rows={3}
                  />
                </label>
                <button type="submit" disabled={isPending("storefront-care")}>
                  {isPending("storefront-care") ? "Sending…" : "Send request"}
                </button>
              </form>
            ) : null}

            {checkoutOpen ? (
              <form className="storefront-checkout" onSubmit={handleCheckoutSubmit}>
                <div className="storefront-card-header">
                  <div className="section-heading">
                    <p className="eyebrow">Checkout</p>
                    <h3>Contact details</h3>
                  </div>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setCheckoutOpen(false)}
                  >
                    Close
                  </button>
                </div>
                <label>
                  Name
                  <input
                    value={checkoutDetails.name}
                    onChange={(event) =>
                      setCheckoutDetails({ ...checkoutDetails, name: event.target.value })
                    }
                    required
                  />
                </label>
                <label>
                  Phone
                  <input
                    value={checkoutDetails.phone}
                    inputMode="tel"
                    onChange={(event) =>
                      setCheckoutDetails({ ...checkoutDetails, phone: event.target.value })
                    }
                    required
                  />
                </label>
                <label>
                  Note
                  <textarea
                    value={checkoutDetails.note}
                    onChange={(event) =>
                      setCheckoutDetails({ ...checkoutDetails, note: event.target.value })
                    }
                    rows={3}
                  />
                </label>
                <button type="submit" disabled={isPending("storefront-order")}>
                  {isPending("storefront-order") ? "Sending order…" : "Send order"}
                </button>
              </form>
            ) : null}
          </div>

          <form className="storefront-composer" onSubmit={handleDraftSubmit}>
            <button
              className="icon-button composer-icon-button"
              type="button"
              aria-label="Voice input"
              onClick={requestVoiceInput}
              disabled={storefrontCardOpen}
            >
              <span className="mic-icon" aria-hidden="true" />
            </button>
            <button
              className="icon-button composer-icon-button"
              type="button"
              aria-label="Attach file"
              onClick={() => storefrontFileInputRef.current?.click()}
              disabled={storefrontCardOpen}
            >
              <span className="attach-icon" aria-hidden="true" />
            </button>
            <input
              ref={storefrontFileInputRef}
              className="chat-file-input"
              type="file"
              multiple
              accept={chatAttachmentAccept}
              onChange={handleStorefrontAttachmentChange}
            />
            <input
              aria-label="Message the storefront agent"
              disabled={storefrontCardOpen}
              placeholder={
                storefrontCardOpen
                  ? "Close the open card to resume chat"
                  : "Ask about products or type checkout"
              }
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" disabled={storefrontCardOpen || isPending("storefront-message")}>
              <span className="send-icon" aria-hidden="true" />
              <span className="visually-hidden">Send</span>
            </button>
          </form>
          <footer className="app-credits">
            <span>Karibu Grogoni</span>
            <BuildIdentity />
          </footer>
        </section>
      </main>
    </Surface>
  );
}

export function readStorefrontVisitorId(): string {
  const storageKey = "grogoni.storefront-visitor.v1";
  const stored = localStorage.getItem(storageKey)?.trim();
  if (stored) return stored;
  const visitorId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `visitor-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(storageKey, visitorId);
  return visitorId;
}

export function findBestPublicProduct(
  message: string,
  products: PublicStorefrontProductSummary[]
): PublicStorefrontProductSummary | null {
  return findBestByName(message, products, (product) => [product.name, product.unit].join(" "));
}
