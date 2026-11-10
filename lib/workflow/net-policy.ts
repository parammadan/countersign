// Where the outbox may send: a URL policy checked at publish, and a resolve-and-pin step run before every send.
// No DNS or network access here: the resolver is injected, and the transport connects to the pinned address only.

/**
 * Resolves a host name to its addresses (A and AAAA, as strings). Injected so tests never touch DNS. A real
 * resolver must return every answer it got, not only the first, so a mixed public/private answer is refused.
 */
export type Resolver = (hostname: string) => Promise<readonly (string | { address: string })[]>;

export interface PinnedTarget {
  /** The original target URL (the transport must not resolve its host itself). */
  url: string;
  /** Host name without brackets, lower case, no trailing dot. */
  hostname: string;
  port: number;
  /** The one address the transport must connect to, in canonical form. */
  address: string;
  family: 4 | 6;
  /** Value for the Host header: the original host, never the pinned address. */
  hostHeader: string;
  /** TLS SNI and certificate name: the original host name, or null when the URL host is an IP literal. */
  servername: string | null;
}

export class TargetRefusedError extends Error {
  constructor(
    /** policy: the target is not allowed (permanent). resolution: the lookup failed (may be retried). */
    public readonly kind: "policy" | "resolution",
    message: string,
  ) {
    super(message);
    this.name = "TargetRefusedError";
  }
}

const MAX_ANSWERS = 32;

/**
 * Returns a reason string when `raw` is not an acceptable delivery target, otherwise null.
 * https only, port 443, no credentials, no localhost/local names, no non-public literal addresses. A name that
 * resolves to a private address passes here and is refused by `resolveAndPin` at send time.
 */
export function validateTargetUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (/[\x00-\x20\x7f\\]/.test(raw)) return "URL contains spaces, control characters or backslashes";
  if (u.protocol !== "https:") return "only https is allowed";
  if (u.username || u.password) return "credentials in URL are not allowed";
  const h = normaliseHost(u.hostname);
  if (!h) return "missing host";
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal") return "local host names are not allowed";
  if (!h.includes(":") && h.split(".").some((label) => label === "")) return "host name has an empty label";
  if (!h.includes(".") && !h.includes(":")) return "single-label host names are not allowed (resolver search domains can make them internal)";
  if (u.port && u.port !== "443") return "only port 443 is allowed";
  if (h.includes(":")) return isPublicAddress(h) ? null : "non-global address";
  if (/^[0-9.]+$/.test(h)) return isPublicAddress(h) ? null : "private address";
  return null;
}

/**
 * Validates the URL, resolves its host once with `resolver`, refuses the target when ANY answer is not a public
 * unicast address, and returns the address the transport must connect to. The transport must not look the name
 * up again (that second lookup is what DNS rebinding exploits).
 */
export async function resolveAndPin(url: string, resolver: Resolver): Promise<PinnedTarget> {
  const bad = validateTargetUrl(url);
  if (bad) throw new TargetRefusedError("policy", bad);
  const u = new URL(url);
  const href = u.href; // normalised form; the transport never sees the raw input
  const hostname = normaliseHost(u.hostname);
  const port = 443;
  const literal = canonicalAddress(hostname);
  if (literal) {
    if (!isPublicAddress(literal.address)) throw new TargetRefusedError("policy", "non-public address");
    return Object.freeze({ url: href, hostname, port, address: literal.address, family: literal.family, hostHeader: literal.family === 6 ? `[${hostname}]` : hostname, servername: null });
  }
  let answers: unknown;
  try {
    answers = await resolver(hostname);
  } catch {
    throw new TargetRefusedError("resolution", "dns lookup failed");
  }
  if (!Array.isArray(answers) || answers.length === 0) throw new TargetRefusedError("resolution", "dns lookup returned no addresses");
  if (answers.length > MAX_ANSWERS) throw new TargetRefusedError("policy", "dns lookup returned too many addresses");
  // strings, or dns.lookup({ all: true })-style { address } objects
  const parsed = answers.map((a) => {
    const s = typeof a === "string" ? a : typeof (a as { address?: unknown })?.address === "string" ? (a as { address: string }).address : null;
    return s === null ? null : canonicalAddress(s);
  });
  if (parsed.some((p) => p === null)) throw new TargetRefusedError("policy", "dns lookup returned an invalid address");
  if (parsed.some((p) => !isPublicAddress(p!.address))) throw new TargetRefusedError("policy", "host resolves to a non-public address");
  const pin = parsed[0]!;
  return Object.freeze({ url: href, hostname, port, address: pin.address, family: pin.family, hostHeader: hostname, servername: hostname });
}

function normaliseHost(hostname: string): string {
  let h = hostname.toLowerCase().replace(/\.+$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

/** Parses an IPv4 (strict dotted decimal) or IPv6 address into canonical text, or null when it is neither. */
export function canonicalAddress(raw: string): { address: string; family: 4 | 6 } | null {
  const v4 = parseIPv4(raw);
  if (v4) return { address: v4.join("."), family: 4 };
  const v6 = parseIPv6(raw);
  if (v6) return { address: formatIPv6(v6), family: 6 };
  return null;
}

/**
 * True only for public unicast addresses. Refused IPv4: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16,
 * 172.16/12, 192.0/16, 192.88.99/24 (6to4 relay), 192.168/16, 198.18/15, 198.51/16, 203.0/16, 224/4 (multicast)
 * and 240/4. 192.0/16, 198.51/16 and 203.0/16 are wider than the reserved /24s (fail closed; kept from the
 * original check). IPv6 is allowed only inside 2000::/3, minus 2001::/23 (Teredo, benchmarking, ORCHID),
 * 2001:db8::/32, 2002::/16 (6to4, which can embed any IPv4 address) and 3fff::/20. That refuses ::, ::1,
 * IPv4-mapped and -compatible forms, NAT64 64:ff9b::/96 and 64:ff9b:1::/48, ULA, link-local, site-local and
 * multicast, whatever IPv4 address they embed. Unparseable input is not public.
 */
export function isPublicAddress(raw: string): boolean {
  const v4 = parseIPv4(raw);
  if (v4) return !privateV4(v4);
  const g = parseIPv6(raw);
  if (!g) return false;
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] < 0x0200) return false;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;
  if (g[0] === 0x2002) return false;
  if (g[0] === 0x3fff && g[1] < 0x1000) return false;
  return true;
}

function privateV4(o: number[]): boolean {
  const [a, b, c] = o;
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

function parseIPv4(s: string): number[] | null {
  if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(s)) return null; // no leading zeros (octal ambiguity)
  const o = s.split(".").map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (!s.includes(":") || s.includes("%")) return null; // zone ids are refused
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const split = (h: string) => (h === "" ? [] : h.split(":"));
  const left = split(halves[0]);
  const right = halves.length === 2 ? split(halves[1]) : [];
  const groups = [...left, ...right];
  if (groups.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  let full: string[];
  if (halves.length === 2) {
    if (groups.length > 7) return null;
    full = [...left, ...Array<string>(8 - groups.length).fill("0"), ...right];
  } else {
    if (groups.length !== 8) return null;
    full = groups;
  }
  return full.map((x) => parseInt(x, 16));
}

/** RFC 5952 text form: lower case, no leading zeros, the longest run of two or more zero groups as "::". */
function formatIPv6(g: number[]): string {
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best < 0) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLen).join(":")}`;
}
