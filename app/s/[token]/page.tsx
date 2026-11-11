import type { Metadata } from "next";
import { loadByToken, expireIfDue, prefillValues, formatDate, copyLinkClosed } from "@/lib/files";
import { signerVerified } from "@/lib/signer";
import { readableBrand } from "@/lib/brand-color";
import { one } from "@/lib/db";
import { now } from "@/lib/util";
import { appUrl } from "@/lib/paths";
import { qrDataUrl } from "@/lib/qr";
import { SigningRoom, VerifyThenDownload, type SignerField } from "@/components/SigningRoom";

export const metadata: Metadata = { title: "Review and sign", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

function Shell({ brand, firm, children }: { brand?: string; firm?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f2f3f6]" style={brand ? { ["--brand" as string]: brand } : undefined}>
      {firm && (
        <header className="border-b border-line bg-white">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
            <span className="font-semibold" style={{ color: brand }}>{firm}</span>
            <span className="text-xs text-muted">Secure signing</span>
          </div>
        </header>
      )}
      <main>{children}</main>
    </div>
  );
}

function Message({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-14">
      <div className="rounded-2xl border border-line bg-white p-6 text-center shadow-sm sm:p-8">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted">{body}</p>
        {children}
      </div>
    </div>
  );
}

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const l = loadByToken(token);
  if (!l)
    return (
      <Shell>
        <Message title="This link isn't valid" body="Check that you opened the full link from your email. If it still doesn't work, ask the sender to resend it." />
      </Shell>
    );
  const { ws, version, fields, pages } = l;
  const file = expireIfDue(l.file, ws);
  const tpl = one<{ name: string }>("SELECT name FROM templates WHERE id = ?", version.template_id)?.name ?? "agreement";
  const shell = (c: React.ReactNode) => <Shell brand={readableBrand(ws.brand_color)} firm={ws.name}>{c}</Shell>;

  if (file.status === "voided") return shell(<Message title="This agreement was withdrawn" body={`${ws.name} cancelled this signing request. Contact them if you think this is a mistake.`} />);
  if (file.status === "declined") return shell(<Message title="You declined this agreement" body={`We let ${ws.name} know. They'll be in touch.`} />);
  if (file.status === "expired") return shell(<Message title="This link has expired" body={`Ask ${ws.name} to send it again. They can reopen it in one click.`} />);
  if (file.status === "draft") return shell(<Message title="Not ready yet" body={`${ws.name} hasn't sent this agreement yet.`} />);
  if (file.status === "signed")
    return shell(<Message title="You've signed" body={`Thanks. ${ws.name} is countersigning now. You'll get the completed copy by email as soon as they do.`} />);
  if (copyLinkClosed(file))
    return shell(<Message title="This link has expired" body={`The agreement was completed more than 30 days ago, so this link no longer opens it. Your signed copy was emailed to you; ${ws.name} can send it again.`} />);
  if (file.status === "completed" && !(await signerVerified(file, ws)))
    return shell(<VerifyThenDownload token={token} email={file.client_email.replace(/^(.{2}).*(@.*)$/, "$1***$2")} />);
  if (file.status === "completed")
    return shell(
      <Message title="This agreement is complete" body="Both parties have signed. Download your copy, with its audit certificate, below.">
        <a href={`/api/sign/${token}/download`} className="mt-6 inline-flex rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white">Download signed copy</a>
      </Message>,
    );

  // Until the emailed code is verified in this browser, send nothing about the agreement's contents.
  const verified = await signerVerified(file, ws);
  const pre = verified ? prefillValues(file, ws, fields) : new Map();
  // "Sign on your phone": a QR code of this same link, made here (never by a third-party service)
  const signUrl = `${appUrl()}/s/${token}`;
  const qr = await qrDataUrl(signUrl);
  const signerFields: SignerField[] = fields.map((f) => {
    const v = pre.get(f.id);
    return { ...f, reason: undefined, confidence: undefined, value: v?.kind === "text" ? v.text : v?.kind === "check" && v.on ? "✓" : undefined };
  });
  return shell(
    <SigningRoom
      token={token}
      firm={ws.name}
      agreement={tpl}
      title={verified ? file.title : ""}
      clientName={verified ? file.client_name : ""}
      clientEmail={verified ? file.client_email : file.client_email.replace(/^(.{2}).*(@.*)$/, "$1***$2")}
      clientCompany={verified ? file.client_company : null}
      pages={verified ? pages : []}
      fields={verified ? signerFields : []}
      today={formatDate(now())}
      requireOtp={!!ws.require_otp}
      otpVerified={verified}
      consented={!!file.consent_at}
      signUrl={signUrl}
      qr={qr}
    />,
  );
}
