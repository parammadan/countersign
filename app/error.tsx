"use client";

export default function RootError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto max-w-lg px-4 py-20 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">Please try again. If you were signing, your progress up to the last step is saved.</p>
      <button onClick={reset} className="mt-5 rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-white">Try again</button>
    </main>
  );
}
