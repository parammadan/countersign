import Link from "next/link";
import { Logo } from "@/components/ui";
import { VerifyForm } from "@/components/VerifyForm";

export const metadata = { title: "Verify a signed document" };

export default function Page() {
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Link href="/"><Logo className="text-lg" /></Link>
      <h1 className="mt-8 text-2xl font-semibold tracking-tight">Verify a signed document</h1>
      <p className="mt-2 text-sm text-muted">
        Drop in a PDF signed through Countersign. We compute its SHA-256 fingerprint in our records and tell you whether it matches, byte for byte, a document we sealed. Any edit, even one character, breaks the match.
      </p>
      <div className="mt-6"><VerifyForm /></div>
    </main>
  );
}
