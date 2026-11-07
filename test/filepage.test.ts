import { describe, it, expect } from "vitest";
import { fileStages, nextStep, reminderPlan } from "../lib/filepage";
import type { FileRow } from "../lib/types";

const base: FileRow = {
  id: "file_1", workspace_id: "ws", template_version_id: "tv", ref: null, title: "MSA: Jordan Sample", client_name: "Jordan Sample", client_email: "jordan@example.com",
  client_company: null, prefill_json: "{}", client_values_json: null, status: "sent", token_hash: "h", token_enc: "e", otp_hash: null, otp_expires_at: null,
  otp_attempts: 0, otp_verified_at: null, consent_at: null, sent_at: "2026-11-01T12:00:00.000Z", viewed_at: null, client_signed_at: null, completed_at: null,
  declined_at: null, decline_reason: null, voided_at: null, expires_at: "2026-11-15T12:00:00.000Z", reminders_sent: 0, last_reminder_at: null, source: "user",
  created_by: null, created_at: "2026-11-01T12:00:00.000Z", email_status: "sent", email_error: null, copy_emailed_at: null,
};
const f = (p: Partial<FileRow>): FileRow => ({ ...base, ...p });
const opts = { admin: true, inviteFailed: false, ready: false, copyEmailed: false, copyFailed: false, outbox: false, autoCountersign: true };

describe("file stages", () => {
  it("marks done steps, the current one and what's left", () => {
    expect(fileStages(f({}), false).map((s) => s.state)).toEqual(["done", "current", "todo", "todo", "todo"]);
    expect(fileStages(f({ status: "signed", viewed_at: "2026-11-02T00:00:00Z", client_signed_at: "2026-11-02T01:00:00Z" }), false).map((s) => s.state)).toEqual(["done", "done", "done", "current", "todo"]);
    const done = fileStages(f({ status: "completed", viewed_at: "x", client_signed_at: "y", completed_at: "z" }), true);
    expect(done.every((s) => s.state === "done")).toBe(true);
    // completed but a required check failed: not ready
    expect(fileStages(f({ status: "completed", viewed_at: "x", client_signed_at: "y", completed_at: "z" }), false).at(-1)!.state).toBe("current");
  });
  it("a closed file stops at the step it reached, labelled with why", () => {
    const d = fileStages(f({ status: "declined", viewed_at: "2026-11-02T00:00:00Z", declined_at: "2026-11-02T00:05:00Z" }), false);
    expect(d.map((s) => s.state)).toEqual(["done", "done", "stopped", "todo", "todo"]);
    expect(d[2]).toMatchObject({ label: "Declined by client", at: "2026-11-02T00:05:00Z" });
    expect(fileStages(f({ status: "expired" }), false)[1]).toMatchObject({ label: "Link expired", state: "stopped", at: base.expires_at });
    expect(fileStages(f({ status: "voided", voided_at: "2026-11-03T00:00:00Z" }), false)[1]).toMatchObject({ label: "Voided", state: "stopped" });
    expect(fileStages(f({ status: "draft", sent_at: null }), false).map((s) => s.state)).toEqual(["todo", "todo", "todo", "todo", "todo"]);
  });
});

describe("reminder plan", () => {
  it("follows the workspace schedule from the send date", () => {
    expect(reminderPlan(f({}), "3,7")).toEqual({ sent: 0, planned: 2, next: "2026-11-04T12:00:00.000Z" });
    expect(reminderPlan(f({ reminders_sent: 1 }), "7, 3")).toEqual({ sent: 1, planned: 2, next: "2026-11-08T12:00:00.000Z" });
    expect(reminderPlan(f({ reminders_sent: 2 }), "3,7")).toMatchObject({ next: null, reason: "done" });
  });
  it("says when there is none, and why", () => {
    expect(reminderPlan(f({}), "")).toMatchObject({ next: null, reason: "off" });
    expect(reminderPlan(f({}), "0,-1,x")).toMatchObject({ next: null, reason: "off", planned: 0 });
    expect(reminderPlan(f({ expires_at: "2026-11-03T00:00:00.000Z" }), "3")).toMatchObject({ next: null, reason: "expires_first" });
    for (const status of ["signed", "completed", "declined", "voided", "expired", "draft"] as const) expect(reminderPlan(f({ status }), "3").reason).toBe("not_open");
  });
});

describe("next step", () => {
  it("names the real next action for each state and role", () => {
    expect(nextStep(f({}), opts).title).toBe("Waiting for Jordan to open the agreement");
    expect(nextStep(f({ status: "viewed" }), opts).title).toBe("Jordan opened it and hasn't signed yet");
    expect(nextStep(f({}), { ...opts, inviteFailed: true, inviteError: "550 mailbox unavailable" })).toMatchObject({ tone: "error", title: "The email to Jordan wasn't delivered" });
    expect(nextStep(f({}), { ...opts, inviteFailed: true, inviteError: "550 mailbox unavailable" }).body).toContain("550 mailbox unavailable");
    expect(nextStep(f({ status: "signed" }), { ...opts, autoCountersign: false })).toMatchObject({ title: "Your countersignature is needed" });
    expect(nextStep(f({ status: "signed" }), { ...opts, autoCountersign: false }).body).toContain("Automatic countersigning is off");
    expect(nextStep(f({ status: "signed" }), { ...opts, admin: false }).title).toBe("Waiting for an admin to countersign");
    expect(nextStep(f({ status: "declined", decline_reason: "wrong fee" }), opts).body).toContain("“wrong fee”");
    expect(nextStep(f({ status: "expired" }), opts).title).toBe("The signing link expired");
    expect(nextStep(f({ status: "voided" }), opts).tone).toBe("neutral");
  });
  it("is only 'ready for work' when the checks pass, and says when the copy didn't go out", () => {
    const done = f({ status: "completed" });
    expect(nextStep(done, { ...opts, ready: false, readinessProblem: "Stored PDF doesn't match" })).toMatchObject({ tone: "error", title: "Not ready for work", body: "Stored PDF doesn't match" });
    expect(nextStep(done, { ...opts, ready: true, copyEmailed: true })).toMatchObject({ tone: "ok", title: "Ready for work" });
    expect(nextStep(done, { ...opts, ready: true, copyFailed: true })).toMatchObject({ tone: "warn", title: "Ready for work, but the client's copy wasn't emailed" });
    expect(nextStep(done, { ...opts, ready: true, outbox: true }).body).toContain("Email delivery isn't configured");
  });
});
