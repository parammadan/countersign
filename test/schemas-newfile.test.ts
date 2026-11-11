import { describe, it, expect } from "vitest";
import { NewFileBody } from "../lib/schemas";

const ok = (v: unknown) => {
  const r = NewFileBody.safeParse(v);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return r.data;
};

describe("NewFileBody", () => {
  it("maps our field names and applies defaults", () => {
    expect(ok({ client_name: "Sample Person", client_email: "Sample@Example.com" })).toEqual({
      templateId: null,
      clientName: "Sample Person",
      clientEmail: "sample@example.com",
      clientCompany: null,
      ref: null,
      title: null,
      prefill: {},
      send: true,
    });
  });
  it("accepts CRM-style aliases", () => {
    const d = ok({ name: "A Test", email: "a@example.com", company: "Example Co", external_ref: 42, template_id: "t1" });
    expect(d).toMatchObject({ clientName: "A Test", clientEmail: "a@example.com", clientCompany: "Example Co", ref: "42", templateId: "t1" });
  });
  it("prefers our names over aliases", () => {
    const d = ok({ client_name: "One", name: "Two", client_email: "a@example.com", email: "b@example.com", agreement_id: "x", template_id: "y", ref: "r1", external_ref: "r2" });
    expect(d).toMatchObject({ clientName: "One", clientEmail: "a@example.com", templateId: "x", ref: "r1" });
  });
  it("trims strings and stringifies numeric refs", () => {
    const d = ok({ client_name: "  Padded  ", client_email: "a@example.com", ref: 7 });
    expect(d.clientName).toBe("Padded");
    expect(d.ref).toBe("7");
  });
  it("strips custom. prefix from prefill keys and stringifies values", () => {
    const d = ok({ client_name: "A", client_email: "a@example.com", prefill: { "custom.fee": 4500, matter: "x", flag: true } });
    expect(d.prefill).toEqual({ fee: "4500", matter: "x", flag: "true" });
  });
  it("send can be turned off", () => {
    expect(ok({ client_name: "A", client_email: "a@example.com", send: false }).send).toBe(false);
  });
  it("rejects missing name with a client_name issue", () => {
    const r = NewFileBody.safeParse({ client_email: "a@example.com" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues.map((i) => i.path.join("."))).toEqual(["client_name"]);
  });
  it("rejects missing or malformed email", () => {
    for (const email of [undefined, "", "nope", "a@b", "a b@example.com", "@example.com"]) {
      const r = NewFileBody.safeParse({ client_name: "A", client_email: email });
      expect(r.success, String(email)).toBe(false);
      expect(!r.success && r.error.issues[0].path).toEqual(["client_email"]);
    }
  });
  it("reports both issues when both are missing", () => {
    const r = NewFileBody.safeParse({});
    expect(!r.success && r.error.issues.map((i) => i.path[0])).toEqual(["client_name", "client_email"]);
  });
  it("enforces length limits", () => {
    expect(NewFileBody.safeParse({ client_name: "x".repeat(201), client_email: "a@example.com" }).success).toBe(false);
    expect(NewFileBody.safeParse({ client_name: "A", client_email: "a@example.com", ref: "x".repeat(121) }).success).toBe(false);
    expect(NewFileBody.safeParse({ client_name: "A", client_email: "a@example.com", prefill: { k: "x".repeat(2001) } }).success).toBe(false);
  });
  it("rejects wrong types", () => {
    expect(NewFileBody.safeParse({ client_name: "A", client_email: "a@example.com", send: "yes" }).success).toBe(false);
    expect(NewFileBody.safeParse({ client_name: 5, client_email: "a@example.com" }).success).toBe(false);
  });
});
