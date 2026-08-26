import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Auch - Carte interactive",
  description:
    "Carte interactive 2D d'Auch, Gers, avec recherche, sélection et couches thématiques basée sur des sources ouvertes.",
  viewport: "width=device-width, initial-scale=1",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}