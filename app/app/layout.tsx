import { requireSession } from "@/lib/auth";
import { getWorkspace } from "@/lib/files";
import { logoutAction } from "@/app/actions";
import { Nav } from "@/components/Nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSession();
  const ws = getWorkspace(s.workspaceId);
  return (
    <div className="min-h-screen lg:flex" style={{ ["--brand" as string]: ws.brand_color }}>
      <Nav firm={ws.name} user={s.userEmail} logout={logoutAction} />
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
