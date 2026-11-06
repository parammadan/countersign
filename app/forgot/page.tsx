import { AuthShell } from "@/components/AuthShell";
import { ForgotForm } from "@/components/ResetForms";
import { Notice } from "@/components/ui";
import { emailMode } from "@/lib/email";

export const metadata = { title: "Reset password" };

export default function Page() {
  return (
    <AuthShell title="Reset your password" sub="We'll email you a link to choose a new one.">
      {emailMode() === "outbox" ? <Notice tone="warn">Email delivery isn&apos;t configured on this server, so reset links can&apos;t be sent. Ask your workspace admin to remove and re-invite you.</Notice> : <ForgotForm />}
    </AuthShell>
  );
}
