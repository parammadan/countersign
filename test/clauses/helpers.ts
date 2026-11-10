// Test-only host authorizer for the clause library. Synthetic ids only.
import type { Actor, ClauseAuthorizer, ClauseRole, ClauseSource } from "../../lib/clauses";

export const WS = "ws-a";
export const WS_B = "ws-b";
export const SRC: ClauseSource = { kind: "firm_template" };

/** Default memberships: two editors, two approvers, one owner-like user with both, one read-only viewer. */
const DEFAULT: Record<string, ClauseRole[]> = {
  "author-1": ["editor"], "author-2": ["editor"], "approver-1": ["approver"], "approver-2": ["approver"],
  "owner-1": ["viewer", "editor", "approver"], "reader-1": ["viewer"],
};

/** A mutable membership table, the way a host would answer from its own members table. */
export class TestAuth implements ClauseAuthorizer {
  private roles = new Map<string, ClauseRole[]>();
  private persons = new Map<string, string>();
  constructor(seed: Record<string, Record<string, ClauseRole[]>> = { [WS]: DEFAULT }) {
    for (const [ws, members] of Object.entries(seed)) for (const [u, r] of Object.entries(members)) this.set(ws, u, r);
  }
  set(ws: string, user: string, roles: ClauseRole[] | null): this {
    const k = `${ws}\u0000${user}`;
    if (roles) this.roles.set(k, roles);
    else this.roles.delete(k);
    return this;
  }
  /** Declares that `user` is the same human as `person` (e.g. a second account). */
  samePersonAs(ws: string, user: string, person: string): this {
    this.persons.set(`${ws}\u0000${user}`, person);
    return this;
  }
  rolesOf(ws: string, user: string): ClauseRole[] | null {
    return this.roles.get(`${ws}\u0000${user}`) ?? null;
  }
  personOf(ws: string, user: string): string | null {
    return this.persons.get(`${ws}\u0000${user}`) ?? user;
  }
}

export const as = (id: string, workspaceId = WS): Actor => ({ workspaceId, id });
