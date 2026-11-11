import type { Metadata } from "next";
import { phoneView } from "@/lib/scan";
import { Logo } from "@/components/ui";
import { PhoneScan, GoneMessage } from "@/components/scan/PhoneScan";

// "Scan with phone", phone side: opened from the QR code on the desktop. No login: the token in the URL is the only
// credential, and the page shows nothing about the workspace (no firm, names, files or agreements). It isn't
// indexed and sends no referrer, so the token never leaves this site.
export const metadata: Metadata = { title: "Scan pages", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const v = await phoneView(token);
  return (
    <div className="min-h-screen bg-[#f2f3f6]">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-xl items-center justify-between px-4 py-3">
          <Logo />
          <span className="text-xs text-muted">Scan pages</span>
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 pt-5 pb-28">
        {v.ok ? <PhoneScan token={token} expiresAt={v.expiresAt} /> : <GoneMessage reason={v.reason === "expired" ? "expired" : v.reason === "invalid" ? "invalid" : "ended"} />}
      </main>
    </div>
  );
}
