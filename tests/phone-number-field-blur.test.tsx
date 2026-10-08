// @vitest-environment jsdom
//
// PhoneNumberField's blur check adds a "Full number" or error line under the field. When the blur
// came from pressing a button below (Continue), adding that line mid-press moved the button and
// the browser dropped the click. The check now waits for the press to finish.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PhoneNumberField } from "../apps/web/src/PhoneNumberField";

let host: HTMLDivElement;
let root: Root;
const onValueChange = vi.fn();
let setFieldValue: (value: string) => void = () => undefined;
let setFieldCountry: (country: "KE" | "UG") => void = () => undefined;

function Field({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const [country, setCountry] = useState<"KE" | "UG">("KE");
  setFieldValue = setValue;
  setFieldCountry = setCountry;
  return (
    <PhoneNumberField
      country={country}
      value={value}
      onCountryChange={(next) => setCountry(next as "KE" | "UG")}
      onValueChange={(next) => {
        onValueChange(next);
        setValue(next);
      }}
    />
  );
}

function input(): HTMLInputElement {
  return host.querySelector("input[type=tel]") as HTMLInputElement;
}

function fullNumberLine(): string | null {
  return (
    Array.from(host.querySelectorAll("p")).find((p) => p.textContent?.startsWith("Full number"))
      ?.textContent ?? null
  );
}

function fire(type: string) {
  act(() => {
    document.body.dispatchEvent(new Event(type, { bubbles: true }));
  });
}

function blurInput() {
  act(() => {
    input().focus();
    input().blur();
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  onValueChange.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  // Close any press a test left open; pointer-press tracking is module-wide.
  fire("click");
  act(() => vi.runAllTimers());
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("PhoneNumberField blur check", () => {
  it("runs at once for a keyboard blur", () => {
    act(() => root.render(<Field initial="0712345678" />));
    blurInput();
    expect(fullNumberLine()).toBe("Full number: +254 712 345678");
  });

  it("waits until a pointer press has produced its click", () => {
    act(() => root.render(<Field initial="0712345678" />));
    fire("pointerdown");
    blurInput();
    expect(fullNumberLine()).toBeNull();

    fire("pointerup");
    expect(fullNumberLine()).toBeNull();
    fire("click");
    act(() => vi.runOnlyPendingTimers());
    expect(fullNumberLine()).toBe("Full number: +254 712 345678");
  });

  it("skips the check when the pressed button already replaced the value", () => {
    act(() => root.render(<Field initial="0712345678" />));
    fire("pointerdown");
    blurInput();
    // Continue normalized the number itself and stored the E.164 form.
    act(() => setFieldValue("+254712345678"));
    fire("click");
    act(() => vi.runOnlyPendingTimers());

    expect(onValueChange).not.toHaveBeenCalled();
    expect(input().value).toBe("+254712345678");
  });

  it("skips the check when the pressed button unmounted the field", () => {
    act(() => root.render(<Field initial="0712345678" />));
    fire("pointerdown");
    blurInput();
    act(() => root.render(<p>Next step</p>));
    fire("click");
    act(() => vi.runOnlyPendingTimers());

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("skips the check when the country changed before the press finished", () => {
    act(() => root.render(<Field initial="0712345678" />));
    fire("pointerdown");
    blurInput();
    act(() => setFieldCountry("UG"));
    fire("click");
    act(() => vi.runOnlyPendingTimers());

    expect(fullNumberLine()).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
