import { assertAuthorizer, assertClauseShape, assertNewVersion, assertVersionUpdate, assertWorkspaceId, assertWriteAuthorized, requireCapability, snapshot } from "./governance";
import { ClauseError, type Clause, type ClauseAuthorizer, type ClauseStore, type ClauseVersion } from "./types";

const copy = <T>(x: T): T => structuredClone(x);

/** In-memory store, partitioned by workspace; every write is checked against the host authorizer. */
export class MemoryClauseStore implements ClauseStore {
  private workspaces = new Map<string, Map<string, Clause>>();

  constructor(private auth: ClauseAuthorizer) {
    assertAuthorizer(auth);
  }

  private ws(workspaceId: string, create = false): Map<string, Clause> | undefined {
    assertWorkspaceId(workspaceId);
    let m = this.workspaces.get(workspaceId);
    if (!m && create) this.workspaces.set(workspaceId, (m = new Map()));
    return m;
  }

  insertClause(workspaceId: string, input: Clause): void {
    assertAuthorizer(this.auth);
    const clause = snapshot(input); // validate and save the same private copy
    assertClauseShape(clause);
    const m = this.ws(workspaceId, true)!;
    if (clause.workspaceId !== workspaceId) throw new ClauseError("bad_workspace", "Clause belongs to another workspace");
    if (m.has(clause.id)) throw new ClauseError("exists", `Clause ${clause.id} already exists`);
    if (clause.versions.length !== 1 || clause.versions[0].version !== 1) throw new ClauseError("bad_version", "A new clause starts with exactly version 1");
    assertNewVersion(clause.versions[0]);
    if (clause.createdBy !== clause.versions[0].provenance.author) throw new ClauseError("immutable", "A clause is created by the author of its first version");
    assertWriteAuthorized(this.auth, workspaceId, null, clause.versions[0]);
    requireCapability(this.auth, workspaceId, clause.createdBy, "edit", "Creating a clause needs edit permission in this workspace");
    m.set(clause.id, clause);
  }
  getClause(workspaceId: string, id: string): Clause | null {
    const c = this.ws(workspaceId)?.get(id);
    return c ? copy(c) : null;
  }
  listClauses(workspaceId: string): Clause[] {
    return [...(this.ws(workspaceId)?.values() ?? [])].map(copy).sort((a, b) => a.id.localeCompare(b.id));
  }
  saveVersion(workspaceId: string, clauseId: string, input: ClauseVersion): void {
    assertAuthorizer(this.auth);
    const version = snapshot(input); // validate and save the same private copy
    const c = this.ws(workspaceId)?.get(clauseId);
    if (!c) throw new ClauseError("not_found", `No clause ${clauseId}`);
    const idx = c.versions.findIndex((v) => v.version === version.version);
    if (idx === -1) {
      if (version.version !== c.versions.length + 1) throw new ClauseError("bad_version", "Versions are numbered consecutively");
      assertNewVersion(version);
      assertWriteAuthorized(this.auth, workspaceId, null, version);
      c.versions.push(version);
    } else {
      assertVersionUpdate(c.versions[idx], version);
      assertWriteAuthorized(this.auth, workspaceId, c.versions[idx], version);
      c.versions[idx] = version;
    }
  }
}
