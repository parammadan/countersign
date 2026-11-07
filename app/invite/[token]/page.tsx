import { one } from "@/lib/db";
import { sha256 } from "@/lib/util";
import { AuthShell } from "@/components/AuthShell";
import { InviteForm } from "@/components/AuthForms";
import { LinkProblem } from "@/components/auth/LinkProblem";
import { BRAND } from "@/lib/brand";

export const metadata = { title: "Join workspace" };

// same 7-day window as acceptInviteAction
function inviteExpired(createdAt: string) {
  return new Date(createdAt).getTime() < Date.now() - 7 * 86400_000;
}

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = one<{ email: string; accepted_at: string | null; created_at: string; ws: string }>(
    "SELECT i.email, i.accepted_at, i.created_at, w.name AS ws FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.token_hash = ?",
    sha256(token),
  );
  if (!inv || inv.accepted_at)
    return (
      <AuthShell title="Invite not valid">
        <LinkProblem href="/login" action="Go to sign in">
          This invite link is invalid or has already been used. Ask your admin for a new one.
        </LinkProblem>
      </AuthShell>
    );
  if (inviteExpired(inv.created_at))
    return (
      <AuthShell title="Invite expired">
        <LinkProblem href="/login" action="Go to sign in">
          This invite has expired. Ask your admin for a new one.
        </LinkProblem>
      </AuthShell>
    );
  const exists = !!one("SELECT 1 FROM users WHERE email = ?", inv.email);
  return (
    <AuthShell title={`Join ${inv.ws}`} sub={`You've been invited to the firm's ${BRAND.name} workspace.`}>
      <InviteForm token={token} email={inv.email} exists={exists} />
    </AuthShell>
  );
}
