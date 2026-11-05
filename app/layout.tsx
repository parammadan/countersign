import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Countersign: client agreements signed on every file", template: "%s · Countersign" },
  description: "Upload your client agreement once. Every new file sends it, collects the signature, countersigns and files the signed copy automatically.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1f4fd1" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
