import { requireAdmin } from "@/lib/auth";
import { all } from "@/lib/db";
import { getWorkspace } from "@/lib/files";
import { getBlob } from "@/lib/storage";
import { Card, PageHeader } from "@/components/ui";
import { CountersignForm, InviteForm, InviteRow, MemberRow, SettingsForm } from "@/components/SettingsForms";
import { emailMode } from "@/lib/email";

export const metadata = { title: "Settings" };

function daysAgo(n: number) {
  return new Date(Date.now() - n * 86400_000).toISOString();
}

export default async function Page() {
  const s = await requireAdmin();
  const ws = getWorkspace(s.workspaceId);
  const img = ws.countersign_image ? `data:image/png;base64,${(await getBlob(ws.countersign_image)).toString("base64")}` : null;
  const members = all<{ user_id: string; name: string; email: string; role: string }>("SELECT m.user_id, u.name, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at", ws.id);
  const invites = all<{ id: string; email: string; role: string; created_at: string }>("SELECT id, email, role, created_at FROM invites WHERE workspace_id = ? AND accepted_at IS NULL ORDER BY created_at DESC", ws.id);
  const weekAgo = daysAgo(7);
  return (
    <>
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <Card id="countersign" className="scroll-mt-6 p-5 sm:p-6">
          <h2 className="mb-1 text-lg font-semibold">Firm countersignature</h2>
          <p className="mb-4 text-sm text-muted">Adopt it once. It goes on every agreement right after the client signs, so nobody at the firm has to touch it.</p>
          <CountersignForm ws={ws} current={img} />
        </Card>
        <Card className="p-5 sm:p-6">
          <h2 className="mb-4 text-lg font-semibold">Workspace</h2>
          <SettingsForm ws={ws} emailOn={emailMode() === "resend"} />
        </Card>
        <Card className="p-5 sm:p-6">
          <h2 className="mb-4 text-lg font-semibold">Team</h2>
          <ul className="mb-4 divide-y divide-line rounded-lg border border-line text-sm">
            {members.map((m) => <MemberRow key={m.user_id} m={m} self={m.user_id === s.userId} />)}
            {invites.map((i) => <InviteRow key={i.id} i={{ ...i, expired: i.created_at < weekAgo }} />)}
          </ul>
          <InviteForm />
        </Card>
      </div>
    </>
  );
}
