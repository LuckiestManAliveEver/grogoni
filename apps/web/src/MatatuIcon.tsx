/** A small matatu (Design D), decorative: always paired with text that says the same thing. */
export function MatatuIcon() {
  return (
    <svg
      className="matatu-icon"
      width="36"
      height="20"
      viewBox="0 0 40 22"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 4h28a4 4 0 014 4l2 8H3z"
        fill="var(--grogoni-accent-ink, #3a2707)"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M7 7h5v4H7zM15 7h5v4h-5zM23 7h5v4h-5z" fill="var(--grogoni-ink, #f4f2ee)" />
      <path d="M3 13h34" stroke="var(--grogoni-sell, #c2543f)" strokeWidth="2" />
      <circle cx="10" cy="18" r="2.6" fill="var(--grogoni-paper, #12151c)" stroke="currentColor" />
      <circle cx="29" cy="18" r="2.6" fill="var(--grogoni-paper, #12151c)" stroke="currentColor" />
    </svg>
  );
}
