"use client";

import { Button } from "./ui";

/** Opens the "Upload a new agreement" panel on the same page and moves focus to its file picker. */
export function UploadPanelButton({ target }: { target: string }) {
  return (
    <Button
      icon="upload"
      onClick={() => {
        const d = document.getElementById(target) as HTMLDetailsElement | null;
        if (!d) return;
        d.open = true;
        d.scrollIntoView({ behavior: "smooth", block: "start" });
        d.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
      }}
    >
      Upload agreement
    </Button>
  );
}
