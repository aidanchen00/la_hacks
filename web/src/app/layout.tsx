import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prana — Wellness Care Navigation",
  description: "Voice-first wellness intake and care navigation — not a medical diagnosis tool.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,300;0,400;0,500;0,600;1,400&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet" />
      </head>
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <body>{children}</body>
    </html>
  );
}
