import Link from "next/link";
import { Notice } from "../ui";

/** Shown in place of a form when an emailed link can't be used (expired, already used, unknown). */
export function LinkProblem({ children, href, action }: { children: React.ReactNode; href: string; action: string }) {
  return (
    <div className="space-y-4" data-testid="link-problem">
      <Notice tone="warn">{children}</Notice>
      <Link href={href} className="block rounded-lg border border-line-strong px-3 py-2 text-center text-sm font-medium text-brand hover:bg-subtle">
        {action}
      </Link>
    </div>
  );
}
