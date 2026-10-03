import type { ShopModuleIcon } from "@grogoni/tool-core";

// Stroke glyphs for Shop Hub modules, drawn in currentColor so they follow the Grogoni Home tokens.
// Keyed by the registry's icon ids; an id this build does not know yet falls back to the kiondo.
const paths: Record<ShopModuleIcon | "kiondo", string> = {
  kiondo:
    "M8 10c0-3.3 1.8-6 4-6s4 2.7 4 6M4 10h16l-1.8 10.4a1.6 1.6 0 0 1-1.6 1.3H7.4a1.6 1.6 0 0 1-1.6-1.3zM5 14h14M5.8 18h12.4",
  box: "M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8",
  supplier: "M3 7h11v9H3zM14 11h4l3 3v2h-7M6.5 19a1.5 1.5 0 1 0 0-.01M17.5 19a1.5 1.5 0 1 0 0-.01",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  bag: "M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2",
  chat: "M4 5h16v11H9l-5 4zM8 9.5h8M8 12.5h5",
  network:
    "M12 5a2 2 0 1 0 0-.01M5 18a2 2 0 1 0 0-.01M19 18a2 2 0 1 0 0-.01M11 6.7 6 16.3M13 6.7l5 9.6M7 18h10",
  wallet: "M4 7h15a1 1 0 0 1 1 1v11H5a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h11v3M16 13h.01",
  truck: "M2 6h12v10H2zM14 10h4l3 3v3h-7M6 18a2 2 0 1 0 0-.01M17 18a2 2 0 1 0 0-.01",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
  agent: "M4 7h16v12H4zM12 7V4M9 12v1M15 12v1",
  chart: "M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6"
};

export function ShopHubIcon({ icon }: { icon: string }) {
  const d = Object.prototype.hasOwnProperty.call(paths, icon)
    ? paths[icon as keyof typeof paths]
    : paths.kiondo;
  return (
    <svg
      aria-hidden="true"
      className="shop-hub-icon"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      <path d={d} />
    </svg>
  );
}
