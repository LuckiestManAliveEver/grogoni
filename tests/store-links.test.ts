import { describe, expect, it } from "vitest";
import { getStoreLinks } from "../packages/shared-types/src/store-links";

describe("getStoreLinks", () => {
  it("builds the web, telegram, and universal links for a configured bot", () => {
    const links = getStoreLinks("grogoni.mama-mboga", {
      webOrigin: "https://grogoni.com",
      telegramBotUsername: "GrogoniBot"
    });
    expect(links).toEqual({
      web: "https://mama-mboga.grogoni.com",
      telegram: "https://t.me/GrogoniBot?start=grogoni.mama-mboga",
      universal: "https://grogoni.com/s/grogoni.mama-mboga"
    });
  });

  it("returns an empty telegram link when no bot username is configured", () => {
    const links = getStoreLinks("grogoni.duka", {
      webOrigin: "https://grogoni.com",
      telegramBotUsername: ""
    });
    expect(links.telegram).toBe("");
  });

  it("strips a trailing slash from the configured web origin", () => {
    const links = getStoreLinks("grogoni.duka", {
      webOrigin: "https://grogoni.com/",
      telegramBotUsername: ""
    });
    expect(links.universal).toBe("https://grogoni.com/s/grogoni.duka");
  });

  it("URL-encodes the grogoniId consistently across all three links", () => {
    const links = getStoreLinks("grogoni.a b", {
      webOrigin: "https://grogoni.com",
      telegramBotUsername: "GrogoniBot"
    });
    expect(links.web).toBe("https://a%20b.grogoni.com");
    expect(links.telegram).toBe("https://t.me/GrogoniBot?start=grogoni.a%20b");
    expect(links.universal).toBe("https://grogoni.com/s/grogoni.a%20b");
  });

  it("strips the grogoni. prefix from the web subdomain but keeps it in telegram/universal", () => {
    const links = getStoreLinks("grogoni.jane", {
      webOrigin: "https://grogoni.com",
      telegramBotUsername: ""
    });
    expect(links.web).toBe("https://jane.grogoni.com");
    expect(links.universal).toBe("https://grogoni.com/s/grogoni.jane");
  });

  it("has no whatsapp field - deliberately deferred", () => {
    const links = getStoreLinks("grogoni.duka", {
      webOrigin: "https://grogoni.com",
      telegramBotUsername: ""
    });
    expect(links).not.toHaveProperty("whatsapp");
  });
});
