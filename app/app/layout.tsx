import type { Metadata } from "next";
import localFont from "next/font/local";
import "@/styles/globals.css";
import { Toaster } from "@/components/ui/toast";
import { AppPerformanceObserver } from "@/components/shell/AppPerformanceObserver";

// Vendored latin variable fonts (next/font/local): next/font/google fetches
// from fonts.googleapis.com at BUILD time, and 2026-08-13 that dependency
// failed three builds in one evening (CI export + two production deploys).
// A build must never depend on a third-party CDN being up.
const manrope = localFont({
  src: "../fonts/manrope-latin-var.woff2",
  variable: "--font-body",
  weight: "200 800",
  display: "swap",
});

const spaceGrotesk = localFont({
  src: "../fonts/space-grotesk-latin-var.woff2",
  variable: "--font-display",
  weight: "300 700",
  display: "swap",
});

export const metadata: Metadata = {
  icons: { icon: "/favicon.svg" },
  title: "Averray · Operator control room",
  description:
    "Trust infrastructure for software agents. Claims, verification, treasury posture, and activity in one signed-in workspace.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${manrope.variable} ${spaceGrotesk.variable}`}>
      <body className="bg-[var(--bg)] text-[var(--ink)] font-[family-name:var(--font-body)]">
        <noscript><p className="p-4">The app needs JavaScript for live data and wallet actions. Read the <a className="underline" href="https://api.averray.com/">public API</a> or visit the <a className="underline" href="https://averray.com/">public site</a>.</p></noscript>
        <AppPerformanceObserver />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
