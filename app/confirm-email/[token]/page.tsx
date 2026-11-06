import { AuthShell } from "@/components/AuthShell";
import { ConfirmEmailForm } from "@/components/VerifyEmailForms";

export const metadata = { title: "Confirm your email" };

// A button, not a GET side effect: link scanners in mail clients open links but don't submit forms.
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthShell title="Confirm your email">
      <ConfirmEmailForm token={token} />
    </AuthShell>
  );
}
