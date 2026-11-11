import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AuthShell } from "@/components/AuthShell";
import { SignupForm } from "@/components/AuthForms";
import { verificationRequired } from "@/lib/emailverify";

export const metadata = { title: "Create a workspace" };

export default async function Page() {
  if (await getSession()) redirect("/app");
  return (
    <AuthShell title="Create your firm's workspace" sub="Free to try. Takes about a minute, then you upload your agreement.">
      <SignupForm confirmNote={verificationRequired()} />
    </AuthShell>
  );
}
