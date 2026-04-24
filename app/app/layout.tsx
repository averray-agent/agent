import type { Metadata } from "next";
import { Manrope, Space_Grotesk } from "next/font/google";
import "@/styles/globals.css";
import { Toaster } from "@/components/ui/toast";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
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
        {children}
        <Toaster />
      </body>
    </html>
  );
}
