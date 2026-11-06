import { requireSession } from "@/lib/auth";
import { getWorkspace } from "@/lib/files";
import { logoutAction } from "@/app/actions";
import { Nav } from "@/components/Nav";
import { UnverifiedBanner } from "@/components/VerifyEmailForms";
import { verificationRequired, workspaceVerified } from "@/lib/emailverify";
import { visibleNav } from "@/lib/nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSession();
  const ws = getWorkspace(s.workspaceId);
  const gate = verificationRequired() && !workspaceVerified(ws.id);
  return (
    <div className="min-h-screen lg:flex" style={{ ["--brand" as string]: ws.brand_color }}>
      <a href="#main" className="sr-only z-[60] rounded-lg bg-white px-3 py-2 text-sm font-medium shadow-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <Nav firm={ws.name} role={s.role} user={s.userEmail} userName={s.userName} groups={visibleNav(s.role)} logout={logoutAction} />
      <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-9 lg:px-10">
        <div className="mx-auto max-w-6xl">
          {gate && <UnverifiedBanner email={s.userEmail} />}
          {children}
        </div>
      </main>
    </div>
  );
}
