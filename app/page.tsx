"use client";

import dynamic from "next/dynamic";

const MapShell = dynamic(
  () => import("@/components/map/MapShell").then((mod) => mod.default),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-label="Chargement de la carte"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          width: "100vw",
          fontFamily:
            "system-ui, -apple-system, sans-serif",
          fontSize: "1rem",
          color: "var(--color-ink)",
          background: "var(--color-paper)",
        }}
      >
        Chargement de la carte…
      </div>
    ),
  }
);

export default function HomePage() {
  return (
    <main
      role="application"
      aria-label="Carte interactive d'Auch"
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        position: "relative",
        background: "var(--color-paper)",
      }}
    >
      <MapShell />
    </main>
  );
}