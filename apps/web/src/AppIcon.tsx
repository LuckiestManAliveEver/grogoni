interface AppIconProps {
  className?: string;
}

export function AppIcon({ className }: AppIconProps) {
  return (
    <img
      aria-hidden="true"
      className={className}
      draggable="false"
      src="/icons/grogoni-icon.svg"
      alt=""
    />
  );
}
