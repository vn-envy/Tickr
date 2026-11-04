import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tickr — Local growth studio",
  description:
    "A thoughtful campaign workspace for local businesses. Start with the facts, find the opportunity, and build a campaign around it.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
