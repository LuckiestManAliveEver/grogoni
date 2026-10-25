/**
 * A shareable click-to-chat WhatsApp link (`https://wa.me/<digits>` or `https://api.whatsapp.com/send`).
 * Pure parsing/normalisation shared by the API (which validates and stores it) and the web app
 * (which pre-validates the field and renders it). Kept side-effect free so both runtimes agree.
 *
 * The value accepted is deliberately narrow: an `http(s)` URL whose host is one of WhatsApp's
 * click-to-chat hosts. Everything else - `tel:`, `javascript:`, arbitrary hosts - is rejected, not
 * silently coerced, so the stored link can never be a disguised redirect or a script URL.
 */
export interface ParsedWhatsAppLink {
  /** The normalised `https://wa.me/<digits>` link, or `https://api.whatsapp.com/send?phone=<digits>`. */
  url: string;
  /** The phone number as bare digits (E.164 without the `+`), e.g. "254712345678". */
  phoneDigits: string;
}

const waMeHost = "wa.me";
const waApiHost = "api.whatsapp.com";
const maximumPhoneDigits = 15;

/**
 * Parses an owner-entered WhatsApp link, or returns `null` when it is empty/blank or not a
 * recognised WhatsApp click-to-chat URL. Callers decide how to surface a rejection (the API returns
 * a 400 `whatsapp_url_invalid`; the web app shows an inline hint).
 */
export function parseWhatsAppShareLink(raw: string): ParsedWhatsAppLink | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // A bare phone number ("+254712345678") is a common paste; accept the digits as a friendly
    // shorthand rather than rejecting it outright.
    const digits = trimmed.replace(/^\+/u, "").replace(/[^0-9]/gu, "");
    return digits.length >= 7 && digits.length <= maximumPhoneDigits
      ? { url: `https://wa.me/${digits}`, phoneDigits: digits }
      : null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase();
  let digits: string;
  if (host === waMeHost || host === `www.${waMeHost}`) {
    if (url.searchParams.has("phone") && url.pathname === "/") {
      // wa.me/?phone=... form
      digits = (url.searchParams.get("phone") ?? "").replace(/[^0-9]/gu, "");
    } else {
      digits = url.pathname.replace(/^\/+/u, "").replace(/[^0-9]/gu, "");
    }
  } else if (host === waApiHost) {
    digits = (url.searchParams.get("phone") ?? "").replace(/[^0-9]/gu, "");
  } else {
    return null;
  }

  if (digits.length < 7 || digits.length > maximumPhoneDigits) return null;
  return { url: `https://wa.me/${digits}`, phoneDigits: digits };
}
