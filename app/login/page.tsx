import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AuthShell } from "@/components/AuthShell";
import { LoginForm } from "@/components/AuthForms";
import { emailMode } from "@/lib/email";

export const metadata = { title: "Sign in" };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getSession()) redirect("/app");
  const { next } = await searchParams;
  return (
    <AuthShell title="Sign in" sub="Welcome back.">
      <LoginForm next={next} canReset={emailMode() !== "outbox"} />
    </AuthShell>
  );
}
