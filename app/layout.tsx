import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { BRAND } from "@/lib/brand";

const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: `${BRAND.name}: client agreements signed on every file`, template: `%s · ${BRAND.name}` },
  description: BRAND.description,
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: BRAND.color };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
