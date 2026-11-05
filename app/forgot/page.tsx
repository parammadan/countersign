import { AuthShell } from "@/components/AuthShell";
import { ForgotForm } from "@/components/ResetForms";

export const metadata = { title: "Reset password" };

export default function Page() {
  return (
    <AuthShell title="Reset your password" sub="We'll email you a link to choose a new one.">
      <ForgotForm />
    </AuthShell>
  );
}
