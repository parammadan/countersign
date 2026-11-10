import crypto from "node:crypto";

/**
 * JSON with object keys sorted recursively, so equal payloads hash equally regardless of key order. An own
 * `__proto__` key is kept as data (a plain `{}` target would turn it into a prototype and drop it silently).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(v: unknown): unknown {
  if (v && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function") return sortKeys((v as { toJSON: () => unknown }).toJSON());
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

const MAX_PAYLOAD_DEPTH = 64;

/**
 * Returns a plain copy of `payload` (null-prototype objects, dense arrays, JSON primitives), refusing anything
 * that JSON would drop or change, so what is hashed, stored, signed and sent is exactly what the caller passed and
 * two different payloads can never share a hash. Every property and toJSON is read exactly once, and the copy is
 * what gets serialised, so a getter or toJSON cannot pass the check with one value and be sent with another.
 * Refused: a `__proto__` key at any depth (receivers that merge it get prototype pollution), non-finite numbers,
 * functions, symbols and BigInt, `undefined`, holes or extra (non-index) properties in arrays, objects other than
 * plain ones (Map, Set, typed arrays, class instances) unless they have toJSON (Date), symbol keys, cycles and
 * nesting deeper than 64. `undefined` object values are allowed: they are absent in the JSON, as in the object.
 */
export function plainJsonCopy(payload: unknown): unknown {
  const stack = new Set<object>();
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (depth > MAX_PAYLOAD_DEPTH) throw new Error(`payload is nested deeper than ${MAX_PAYLOAD_DEPTH} levels`);
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error(`payload ${path} is not a finite number`);
      return v;
    }
    if (typeof v !== "object") throw new Error(`payload ${path} is a ${typeof v}, which is not JSON`);
    if (stack.has(v)) throw new Error(`payload ${path} is circular`);
    stack.add(v);
    try {
      const toJSON = (v as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") return walk(toJSON.call(v, ""), path, depth + 1);
      if (Array.isArray(v)) {
        const len = v.length;
        for (const k of Reflect.ownKeys(v)) {
          if (k === "length") continue;
          if (typeof k !== "string" || String(Number(k)) !== k || Number(k) >= len) throw new Error(`payload ${path} is an array with extra properties`);
        }
        const out: unknown[] = [];
        for (let i = 0; i < len; i++) {
          if (!Object.prototype.hasOwnProperty.call(v, i)) throw new Error(`payload ${path}[${i}] is a hole in a sparse array`);
          const x = v[i];
          if (x === undefined) throw new Error(`payload ${path}[${i}] is undefined`);
          out.push(walk(x, `${path}[${i}]`, depth + 1));
        }
        return out;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error(`payload ${path} is not a plain object`);
      if (Object.getOwnPropertySymbols(v).length) throw new Error(`payload ${path} has symbol keys`);
      const out: Record<string, unknown> = Object.create(null);
      for (const k of Object.keys(v)) {
        if (k === "__proto__") throw new Error(`payload ${path} has a "__proto__" key`);
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = walk(x, `${path}.${k}`, depth + 1);
      }
      return out;
    } finally {
      stack.delete(v);
    }
  };
  return walk(payload, "$", 0);
}

/** Throws unless `payload` is plain JSON data (see plainJsonCopy). */
export function assertJsonPayload(payload: unknown): void {
  plainJsonCopy(payload);
}
