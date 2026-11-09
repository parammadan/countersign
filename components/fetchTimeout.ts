// Client-side requests that can't hang forever: each is aborted after a time limit, and every way it can fail
// (timeout, no connection, an error status, a body that isn't JSON) comes back as a message to show, not a throw.
export type JsonResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number | null; error: string; timedOut: boolean; data: Partial<T> & { error?: string } };

export const TIMEOUT_MESSAGE = "The server is taking too long to respond. Check your connection and try again.";
export const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

export async function fetchJson<T>(url: string, init: RequestInit = {}, o: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<JsonResult<T>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 30_000);
  try {
    const r = await (o.fetchImpl ?? fetch)(url, { ...init, signal: ctl.signal });
    const data = (await r.json().catch(() => ({}))) as Partial<T> & { error?: string };
    if (r.ok) return { ok: true, status: r.status, data: data as T };
    return { ok: false, status: r.status, error: data.error || `The request failed (${r.status}). Try again.`, timedOut: false, data };
  } catch {
    const timedOut = ctl.signal.aborted;
    return { ok: false, status: null, error: timedOut ? TIMEOUT_MESSAGE : OFFLINE_MESSAGE, timedOut, data: {} };
  } finally {
    clearTimeout(timer);
  }
}
