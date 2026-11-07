// A minimal SMTP server for browser tests: the app sends real email to it over SMTP, the test reads what
// arrived, and can make it refuse chosen recipients (a real 550) to test failed delivery and recovery.
// Plain SMTP with AUTH and no TLS, enough for nodemailer on a non-465 port. Test use only.
import net from "node:net";

export type Received = { from: string; to: string[]; raw: string; at: number };

export function smtpSink(port: number) {
  const received: Received[] = [];
  let reject: (to: string) => boolean = () => false;
  const server = net.createServer((sock) => {
    let buf = "";
    let data = false;
    let msg: { from: string; to: string[] } = { from: "", to: [] };
    let authStep = 0;
    const say = (s: string) => sock.write(s + "\r\n");
    say("220 sink ESMTP test");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (data) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          received.push({ ...msg, raw: buf.slice(0, end).replace(/\r\n\.\./g, "\r\n."), at: Date.now() });
          buf = buf.slice(end + 5);
          data = false;
          msg = { from: "", to: [] };
          say("250 2.0.0 queued");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (authStep) {
          authStep = authStep === 1 ? (say("334 UGFzc3dvcmQ6"), 2) : (say("235 2.7.0 ok"), 0);
        } else if (cmd === "EHLO" || cmd === "HELO") sock.write("250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (cmd === "AUTH") {
          if (/^AUTH LOGIN\s*$/i.test(line)) (say("334 VXNlcm5hbWU6"), (authStep = 1));
          else if (/^AUTH LOGIN /i.test(line)) (say("334 UGFzc3dvcmQ6"), (authStep = 2));
          else say("235 2.7.0 ok");
        } else if (cmd === "MAIL") (msg.from = line.match(/<([^>]*)>/)?.[1] ?? ""), say("250 ok");
        else if (cmd === "RCPT") {
          const to = line.match(/<([^>]*)>/)?.[1] ?? "";
          if (reject(to)) say("550 5.1.1 mailbox unavailable");
          else (msg.to.push(to), say("250 ok"));
        } else if (cmd === "DATA") (data = true), say("354 go ahead");
        else if (cmd === "RSET") (msg = { from: "", to: [] }), say("250 ok");
        else if (cmd === "QUIT") (say("221 bye"), sock.end());
        else say("250 ok");
      }
    });
    sock.on("error", () => {});
  });
  return {
    received,
    /** refuse these recipients with a permanent 550 until changed */
    refuse(fn: (to: string) => boolean) {
      reject = fn;
    },
    start: () => new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r())),
    stop: () => new Promise<void>((r) => server.close(() => r())),
    /** the newest message to this address whose subject matches */
    find(to: string, subject: RegExp) {
      return [...received].reverse().find((m) => m.to.includes(to) && subject.test(decodeSubject(m.raw)));
    },
    count(to: string, subject: RegExp) {
      return received.filter((m) => m.to.includes(to) && subject.test(decodeSubject(m.raw))).length;
    },
  };
}

function decodeSubject(raw: string) {
  const line = raw.match(/^Subject: (.*(?:\r\n[ \t].*)*)/im)?.[1] ?? "";
  return line.replace(/\r\n[ \t]/g, " ").replace(/=\?utf-8\?([BQ])\?([^?]*)\?=/gi, (_, enc, s) => (enc.toUpperCase() === "B" ? Buffer.from(s, "base64").toString("utf8") : s.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16)))));
}

/** Body text with quoted-printable soft breaks undone, for finding links. */
export function bodyText(raw: string) {
  return raw.replace(/=\r?\n/g, "").replace(/=3D/gi, "=");
}

export function linkIn(raw: string, path: string) {
  return bodyText(raw).match(new RegExp(`https?://[^\\s"'<>]+/${path}/[A-Za-z0-9_-]+`))?.[0];
}

export function pdfAttachment(raw: string): Buffer | null {
  const i = raw.search(/Content-Type: application\/pdf/i);
  if (i < 0) return null;
  const rest = raw.slice(i);
  return Buffer.from(rest.slice(rest.search(/\r?\n\r?\n/)).split(/\r?\n--/)[0].replace(/\s+/g, ""), "base64");
}
