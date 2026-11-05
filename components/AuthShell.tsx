import Link from "next/link";
import { Logo } from "./ui";

export function AuthShell({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <Link href="/" className="mb-8 text-lg"><Logo /></Link>
      <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 mb-6 text-sm text-muted">{sub}</p>}
        {!sub && <div className="mb-6" />}
        {children}
      </div>
    </main>
  );
}
