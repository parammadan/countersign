// A local stand-in for the Anthropic Messages API, for browser tests of the AI answer path at no cost. The app
// reaches it only through AI_TEST_ENDPOINT (loopback only). Answers are scripted per question and built from the
// passages the app actually sent, so the app's checks run on real requests and responses.
import http from "node:http";

export const MOCK_PORT = 2527;
export type Seen = { apiKey: string | undefined; beta: string | undefined; cached: boolean; question: string; earlierTurns: boolean; /** the second call, which judges an answer */ verifier: boolean };

type Passage = { id: string; text: string };
export type Script = (q: string, ps: Passage[], seen: Seen) => { status?: number; answer?: Record<string, unknown> };
/** The verifier's verdicts for one answer (its text, as the app sent it); by default every sentence is supported. */
export type VerifyScript = (answer: string, ps: Passage[], q: string) => { status?: number; answer?: Record<string, unknown> };
const approve: VerifyScript = (answer, ps) => {
  const p = ps.find((x) => !/binding="false"/.test(x.text)) ?? ps[0];
  return { answer: { claims: answer.split(/(?<=[.!?])\s+/).filter((c) => c.trim().length > 2).map((claim) => ({ claim, kind: "term", material: true, verdict: "supported", evidence: [{ passage: p.id, quote: p.text.slice(0, 40) }], reason: "", span: claim })) } };
};

export function startMockAnthropic(script: Script, verify: VerifyScript = approve): Promise<{ close: () => Promise<void>; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body || "{}") as { system?: string; messages?: { content: string | { type: string; text: string; cache_control?: unknown }[] }[] };
      const isVerifier = /independently verify/.test(String(b.system ?? ""));
      const content = b.messages?.[0]?.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content ?? [];
      const text = blocks.map((x) => x.text).join("\n");
      const ps = [...text.matchAll(/<passage id="([^"]+)" page="\d+">([\s\S]*?)<\/passage>/g)].map((m) => ({ id: m[1], text: m[2] }));
      // the new question is the last one; earlier turns carry their own <question> tags
      const question = [...text.matchAll(/<question>([\s\S]*?)<\/question>/g)].at(-1)?.[1] ?? "";
      const s: Seen = { apiKey: (req.headers["x-api-key"] as string | undefined) ?? (req.headers.authorization?.replace(/^Bearer\s+/i, "") || undefined), beta: req.headers["anthropic-beta"] as string | undefined, cached: blocks.some((x) => typeof x === "object" && "cache_control" in x && !!x.cache_control), question, earlierTurns: text.includes("<earlier_turns>"), verifier: isVerifier };
      seen.push(s);
      // the answer under review: its text, explanation, calculations and notes (the app writes ‹ › for < >)
      // the last <answer> block (earlier turns carry their own)
      const reviewed = (text.includes("</answer>") ? text.slice(text.lastIndexOf("<answer>") + 8, text.lastIndexOf("</answer>")) : "").replace(/<\/?(?:text|explanation|calculation|note)>/g, " ").replace(/\s+/g, " ").trim();
      const out = isVerifier ? verify(reviewed, ps, question) : script(question, ps, s);
      if (out.status && out.status !== 200) {
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "mock failure" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_mock_${seen.length}`,
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: JSON.stringify(out.answer) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 120, output_tokens: 900, cache_creation_input_tokens: seen.length === 1 ? 2400 : 0, cache_read_input_tokens: seen.length === 1 ? 0 : 2400 },
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve({ seen, close: () => new Promise<void>((r) => server.close(() => r())) })));
}
