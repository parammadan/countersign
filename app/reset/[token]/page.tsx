import { AuthShell } from "@/components/AuthShell";
import { ResetForm } from "@/components/ResetForms";
import { LinkProblem } from "@/components/auth/LinkProblem";
import { one } from "@/lib/db";
import { sha256 } from "@/lib/util";

export const metadata = { title: "Choose a new password" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = one<{ expires_at: string; used_at: string | null }>("SELECT expires_at, used_at FROM password_resets WHERE token_hash = ?", sha256(token));
  if (!r || r.used_at || r.expires_at < new Date().toISOString())
    return (
      <AuthShell title="Reset link not valid">
        <LinkProblem href="/forgot" action="Request a new reset link">
          This reset link is invalid, has expired, or was already used. Reset links work once.
        </LinkProblem>
      </AuthShell>
    );
  return (
    <AuthShell title="Choose a new password">
      <ResetForm token={token} />
    </AuthShell>
  );
}
