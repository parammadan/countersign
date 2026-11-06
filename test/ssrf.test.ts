import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkWebhookUrl, privateIp, safeFetch } from "../lib/ssrf";

describe("webhook SSRF guard", () => {
  it("classifies internal addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "fec0::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1"]) expect(privateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(privateIp(ip), ip).toBe(false);
  });
  it("rejects bad URLs when saving", async () => {
    await expect(checkWebhookUrl("http://example.com/x")).rejects.toThrow(/https/);
    await expect(checkWebhookUrl("https://127.0.0.1/x")).rejects.toThrow(/hostname/);
    await expect(checkWebhookUrl("https://[::ffff:127.0.0.1]/x")).rejects.toThrow(/hostname/);
    await expect(checkWebhookUrl("https://localhost/x")).rejects.toThrow(/public/);
    await expect(checkWebhookUrl("https://user:pw@example.com/x")).rejects.toThrow(/credentials/);
  });
  it("refuses to connect to a private address at send time, even if it's listening", async () => {
    let hit = false;
    const srv = http.createServer((_, res) => {
      hit = true;
      res.end("ok");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    await expect(safeFetch(`http://localhost:${port}/`, { method: "POST", headers: {}, body: "{}" })).rejects.toThrow();
    expect(hit).toBe(false);
    process.env.ALLOW_PRIVATE_WEBHOOKS = "1";
    const ok = await safeFetch(`http://localhost:${port}/`, { method: "POST", headers: {}, body: "{}" });
    expect(ok.status).toBe(200);
    delete process.env.ALLOW_PRIVATE_WEBHOOKS;
    srv.close();
  });
});
