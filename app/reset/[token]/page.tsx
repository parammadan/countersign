import { AuthShell } from "@/components/AuthShell";
import { ResetForm } from "@/components/ResetForms";

export const metadata = { title: "Choose a new password" };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthShell title="Choose a new password">
      <ResetForm token={token} />
    </AuthShell>
  );
}
