import { one } from "@/lib/db";
import { sha256 } from "@/lib/util";
import { AuthShell } from "@/components/AuthShell";
import { InviteForm } from "@/components/AuthForms";
import { Notice } from "@/components/ui";

export const metadata = { title: "Join workspace" };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = one<{ email: string; accepted_at: string | null; ws: string }>(
    "SELECT i.email, i.accepted_at, w.name AS ws FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.token_hash = ?",
    sha256(token),
  );
  if (!inv || inv.accepted_at)
    return (
      <AuthShell title="Invite not valid">
        <Notice tone="warn">This invite link is invalid or has already been used. Ask your admin for a new one.</Notice>
      </AuthShell>
    );
  const exists = !!one("SELECT 1 FROM users WHERE email = ?", inv.email);
  return (
    <AuthShell title={`Join ${inv.ws}`} sub="You've been invited to the firm's Countersign workspace.">
      <InviteForm token={token} email={inv.email} exists={exists} />
    </AuthShell>
  );
}
