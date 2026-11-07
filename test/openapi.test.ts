// Keeps public/openapi.json honest: structurally valid OpenAPI 3, every API route file documented (and nothing
// documented that doesn't exist), and the documented fields matching the code that produces them.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const spec = JSON.parse(fs.readFileSync(path.join(root, "public/openapi.json"), "utf8"));

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...routeFiles(p));
    else if (/^route\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

// app/api/v1/files/[id]/route.ts -> /api/v1/files/{id}
function urlOf(file: string) {
  const rel = path.relative(path.join(root, "app"), path.dirname(file)).split(path.sep);
  return "/" + rel.map((s) => s.replace(/^\[(.+)\]$/, "{$1}")).join("/");
}

function exportedMethods(file: string) {
  const src = fs.readFileSync(file, "utf8");
  return [...src.matchAll(/export\s+(?:const|async\s+function|function)\s+(GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH)\b/g)].map((m) => m[1].toLowerCase());
}

// The routes the reference covers: the public API, and the inbound webhook.
const documented = [...routeFiles(path.join(root, "app/api/v1")), ...routeFiles(path.join(root, "app/api/inbound"))];

function resolve(ref: string): unknown {
  expect(ref.startsWith("#/"), `only local refs are used: ${ref}`).toBe(true);
  let node: unknown = spec;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
    expect(node, `$ref ${ref} resolves`).toBeDefined();
  }
  return node;
}

function walk(node: unknown, visit: (n: Record<string, unknown>, at: string) => void, at = "#") {
  if (Array.isArray(node)) node.forEach((n, i) => walk(n, visit, `${at}/${i}`));
  else if (node && typeof node === "object") {
    visit(node as Record<string, unknown>, at);
    for (const [k, v] of Object.entries(node)) walk(v, visit, `${at}/${k}`);
  }
}

function props(schemaRef: string) {
  return Object.keys((resolve(schemaRef) as { properties: Record<string, unknown> }).properties).sort();
}

describe("openapi.json is valid OpenAPI 3", () => {
  it("has the required top-level structure", () => {
    expect(spec.openapi).toMatch(/^3\.\d+\.\d+$/);
    expect(typeof spec.info?.title).toBe("string");
    expect(typeof spec.info?.version).toBe("string");
    expect(spec.paths && typeof spec.paths).toBe("object");
    const allowed = ["openapi", "info", "jsonSchemaDialect", "servers", "paths", "webhooks", "components", "security", "tags", "externalDocs"];
    for (const k of Object.keys(spec)) expect(allowed.includes(k) || k.startsWith("x-"), `top-level key ${k}`).toBe(true);
  });

  it("has well-formed paths and operations", () => {
    const opIds = new Set<string>();
    for (const [p, item] of Object.entries(spec.paths as Record<string, Record<string, unknown>>)) {
      expect(p.startsWith("/"), p).toBe(true);
      const templated = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const [m, op] of Object.entries(item)) {
        if (!METHODS.includes(m)) continue;
        const o = op as { operationId?: string; responses?: Record<string, unknown>; parameters?: { $ref?: string }[] };
        expect(o.responses && Object.keys(o.responses).length, `${m} ${p} has responses`).toBeTruthy();
        for (const code of Object.keys(o.responses!)) expect(code, `${m} ${p} response code`).toMatch(/^([1-5](\d\d|XX)|default)$/);
        if (o.operationId) {
          expect(opIds.has(o.operationId), `operationId ${o.operationId} is unique`).toBe(false);
          opIds.add(o.operationId);
        }
        const params = (o.parameters ?? []).map((x) => (x.$ref ? resolve(x.$ref) : x) as { name: string; in: string; required?: boolean });
        for (const name of templated) {
          const pp = params.find((x) => x.in === "path" && x.name === name);
          expect(pp, `${m} ${p} declares path parameter ${name}`).toBeDefined();
          expect(pp!.required, `${m} ${p} path parameter ${name} is required`).toBe(true);
        }
        for (const x of params) expect(["query", "header", "path", "cookie"]).toContain(x.in);
      }
    }
  });

  // operations from paths, webhooks and reusable path items, so all three get the same checks
  const pathItems = (): [string, Record<string, unknown>][] => [
    ...Object.entries(spec.paths ?? {}),
    ...Object.entries(spec.webhooks ?? {}).map(([k, v]) => [`webhook ${k}`, v]),
    ...Object.entries(spec.components?.pathItems ?? {}).map(([k, v]) => [`pathItem ${k}`, v]),
  ] as [string, Record<string, unknown>][];

  it("uses only allowed path item and operation keys", () => {
    const itemKeys = ["$ref", "summary", "description", "servers", "parameters", ...METHODS];
    const opKeys = ["tags", "summary", "description", "externalDocs", "operationId", "parameters", "requestBody", "responses", "callbacks", "deprecated", "security", "servers"];
    for (const [at, item] of pathItems()) {
      for (const [k, op] of Object.entries(item)) {
        expect(itemKeys.includes(k) || k.startsWith("x-"), `${at}: path item key ${k}`).toBe(true);
        if (!METHODS.includes(k)) continue;
        for (const ok of Object.keys(op as object)) expect(opKeys.includes(ok) || ok.startsWith("x-"), `${at} ${k}: operation key ${ok}`).toBe(true);
      }
    }
  });

  it("gives every parameter a name and a schema or content, and every response a description", () => {
    type Param = { name?: string; in?: string; schema?: unknown; content?: unknown };
    const checkParam = (raw: Param & { $ref?: string }, at: string) => {
      const x = (raw.$ref ? resolve(raw.$ref) : raw) as Param;
      expect(typeof x.name === "string" && x.name.length > 0, `${at}: parameter has a name`).toBe(true);
      expect(["query", "header", "path", "cookie"], `${at}: parameter ${x.name} location`).toContain(x.in);
      expect(!!x.schema !== !!x.content, `${at}: parameter ${x.name} has exactly one of schema and content`).toBe(true);
    };
    const checkResponse = (raw: { $ref?: string; description?: unknown }, at: string) => {
      const r = (raw.$ref ? resolve(raw.$ref) : raw) as { description?: unknown };
      expect(typeof r.description === "string" && r.description.length > 0, `${at}: response has a description`).toBe(true);
    };
    let ops = 0;
    for (const [at, item] of pathItems()) {
      for (const p of (item.parameters as Param[] | undefined) ?? []) checkParam(p, at);
      for (const [m, op] of Object.entries(item)) {
        if (!METHODS.includes(m)) continue;
        ops++;
        const o = op as { parameters?: Param[]; responses?: Record<string, { description?: string }> };
        for (const p of o.parameters ?? []) checkParam(p, `${at} ${m}`);
        expect(o.responses && Object.keys(o.responses).length, `${at} ${m} has responses`).toBeTruthy();
        for (const [code, r] of Object.entries(o.responses!)) checkResponse(r, `${at} ${m} ${code}`);
      }
    }
    expect(ops).toBeGreaterThan(8);
    for (const [k, p] of Object.entries(spec.components?.parameters ?? {})) checkParam(p as Param, `components.parameters.${k}`);
    for (const [k, r] of Object.entries(spec.components?.responses ?? {})) checkResponse(r as { description?: string }, `components.responses.${k}`);
  });

  it("uses only valid JSON Schema type names", () => {
    const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
    let typed = 0;
    // a schema's own `type` is a string or an array; a property *named* "type" is an object, so is skipped
    const visit = (n: Record<string, unknown>, at: string) => {
      if (typeof n.type !== "string" && !Array.isArray(n.type)) return;
      for (const t of [n.type].flat()) expect(TYPES, `${at}: type ${String(t)}`).toContain(t);
      typed++;
    };
    walk(spec.components?.schemas ?? {}, visit, "#/components/schemas");
    walk([spec.paths, spec.webhooks, spec.components?.parameters, spec.components?.responses, spec.components?.pathItems], (n, at) => {
      if (n.schema && typeof n.schema === "object") walk(n.schema, visit, `${at}/schema`);
    });
    expect(typed).toBeGreaterThan(20);
  });

  it("has server URLs that are literal URLs (no unresolved templates)", () => {
    expect(spec.servers?.length).toBeGreaterThan(0);
    for (const s of spec.servers as { url: string }[]) {
      expect(s.url, "server url has no {variables}").not.toMatch(/[{}]/);
      expect(() => new URL(s.url), `server url ${s.url} parses`).not.toThrow();
    }
  });

  it("resolves every $ref and declares every security scheme it uses", () => {
    let refs = 0;
    walk(spec, (n) => {
      if (typeof n.$ref === "string") {
        resolve(n.$ref);
        refs++;
      }
    });
    expect(refs).toBeGreaterThan(10);
    const schemes = Object.keys(spec.components?.securitySchemes ?? {});
    const uses = [spec.security ?? [], ...Object.values(spec.paths as Record<string, Record<string, { security?: unknown[] }>>).flatMap((i) => Object.values(i).map((o) => o.security ?? []))];
    for (const req of uses.flat() as Record<string, unknown>[]) for (const k of Object.keys(req)) expect(schemes).toContain(k);
  });
});

describe("openapi.json covers every route", () => {
  it("finds the route files", () => {
    expect(documented.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of documented) {
    const url = urlOf(file);
    it(`documents ${path.relative(root, file)}`, () => {
      const item = spec.paths[url];
      expect(item, `paths["${url}"] exists`).toBeDefined();
      const methods = exportedMethods(file);
      expect(methods.length, `${url} exports a handler`).toBeGreaterThan(0);
      for (const m of methods) expect(item[m], `${m.toUpperCase()} ${url} is documented`).toBeDefined();
      for (const m of Object.keys(item).filter((k) => METHODS.includes(k))) expect(methods, `${m.toUpperCase()} ${url} exists in code`).toContain(m);
    });
  }

  it("documents no route that doesn't exist", () => {
    const urls = new Set(documented.map(urlOf));
    for (const p of Object.keys(spec.paths)) expect(urls.has(p), `${p} has a route file`).toBe(true);
  });
});

describe("openapi.json matches the code", () => {
  let files: typeof import("../lib/files");

  beforeAll(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cs-openapi-"));
    process.env.APP_URL = "http://localhost:3000";
    files = await import("../lib/files");
  });

  it("File has exactly the fields fileJson returns", () => {
    const row = {
      id: "file_x", ref: null, title: "Engagement: Sample Client", status: "draft", client_name: "Sample Client", client_email: "client@example.com",
      client_company: null, prefill_json: "{}", created_at: "2026-01-01T00:00:00.000Z", token_enc: null,
    } as unknown as import("../lib/types").FileRow;
    const json = files.fileJson(row);
    expect(props("#/components/schemas/File")).toEqual(Object.keys(json).sort());
    expect(Object.keys((resolve("#/components/schemas/File") as { properties: { client: { properties: object } } }).properties.client.properties).sort()).toEqual(Object.keys(json.client).sort());
    expect(Object.keys((resolve("#/components/schemas/File") as { properties: { email: { properties: object } } }).properties.email.properties).sort()).toEqual(Object.keys(json.email).sort());
  });

  it("NewFile has exactly the fields NewFileBody accepts", async () => {
    const { NewFileBody } = await import("../lib/schemas");
    const shape = (NewFileBody as unknown as { in: { shape: Record<string, unknown> } }).in.shape;
    expect(props("#/components/schemas/NewFile")).toEqual(Object.keys(shape).sort());
  });

  it("FileStatus lists every status", async () => {
    const { STATUS_LABEL } = await import("../lib/types");
    expect([...(resolve("#/components/schemas/FileStatus") as { enum: string[] }).enum].sort()).toEqual(Object.keys(STATUS_LABEL).sort());
  });

  it("documents every outbound webhook event, and only those", async () => {
    const { WEBHOOK_EVENTS } = await import("../lib/webhooks");
    expect(Object.keys(spec.webhooks).sort()).toEqual([...WEBHOOK_EVENTS].sort());
    expect([...(resolve("#/components/schemas/EventName") as { enum: string[] }).enum].sort()).toEqual([...WEBHOOK_EVENTS].sort());
  });
});
