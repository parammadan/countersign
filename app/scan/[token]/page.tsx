import type { Metadata } from "next";
import { headers } from "next/headers";
import { AppError } from "@/lib/errors";
import { phoneView } from "@/lib/scan";
import { phoneLimit } from "@/lib/scan-http";
import { Logo } from "@/components/ui";
import { PhoneScan, GoneMessage } from "@/components/scan/PhoneScan";

// "Scan with phone", phone side: opened from the QR code on the desktop. No login: the token in the URL is the only
// credential, and the page shows nothing about the workspace (no firm, names, files or agreements). It isn't
// indexed and sends no referrer, so the token never leaves this site. Loading it counts against the same per-token
// and per-address limits as the phone's API requests.
export const metadata: Metadata = { title: "Scan pages", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

async function view(token: string) {
  try {
    phoneLimit(await headers(), token);
  } catch (e) {
    if (e instanceof AppError && e.status === 429) return { ok: false as const, reason: "busy" as const };
    throw e;
  }
  return phoneView(token);
}

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const v = await view(token);
  return (
    <div className="min-h-screen bg-[#f2f3f6]">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-xl items-center justify-between px-4 py-3">
          <Logo />
          <span className="text-xs text-muted">Scan pages</span>
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 pt-5 pb-28">
        {v.ok ? (
          <PhoneScan token={token} expiresAt={v.expiresAt} />
        ) : (
          <GoneMessage reason={v.reason === "busy" ? "busy" : v.reason === "expired" ? "expired" : v.reason === "invalid" ? "invalid" : "ended"} />
        )}
      </main>
    </div>
  );
}
