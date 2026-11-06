"use client";

import Link from "next/link";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const msg = error.message && !/digest|server components/i.test(error.message) ? error.message : null;
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-xl font-semibold">That didn&apos;t work</h1>
      <p className="mt-2 text-sm text-muted">{msg ?? "Something went wrong on our side. Nothing was lost; try again."}</p>
      <div className="mt-5 flex justify-center gap-2">
        <button onClick={reset} className="rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-white">Try again</button>
        <Link href="/app" className="rounded-lg border border-line bg-white px-3.5 py-2 text-sm font-medium">Command center</Link>
      </div>
    </div>
  );
}
