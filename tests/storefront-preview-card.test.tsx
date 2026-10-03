// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StorefrontPreviewCard } from "../apps/web/src/StorefrontPreviewCard";

describe("StorefrontPreviewCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the public commerce address under the business name, not the raw grogoniId", () => {
    act(() => {
      root = createRoot(host);
      root.render(
        <StorefrontPreviewCard
          businessName="Mama Mboga"
          products={[]}
          grogoniId="grogoni.mama-mboga"
          onBack={() => {}}
          onOpenProfile={() => {}}
          onAddToOrder={() => {}}
          onSell={() => {}}
          onMessage={() => {}}
        />
      );
    });

    expect(host.textContent).toContain("mama-mboga@grogoni.com");
    expect(host.textContent).not.toContain("grogoni.mama-mboga");
  });
});
