import type { ReactNode } from "react";

export interface SurfaceProps {
  children: ReactNode;
  title: string;
}

export function Surface({ children, title }: SurfaceProps) {
  return (
    <section className="grogoni-surface" aria-label={title}>
      <h1>{title}</h1>
      {children}
    </section>
  );
}
