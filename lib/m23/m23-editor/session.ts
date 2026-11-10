import type { EditorState } from "./proposals";
import { openProposals } from "./proposals";
import type { VersionHistory } from "./history";
import { latestVersion } from "./history";

/**
 * Derive the gate values the approval functions need from the editor and history, instead of trusting hand-written ones.
 * `history` is passed through so that approve/publish run the party-drift check themselves on the committed version
 * (see `checkCommittedParties`); the editor's own base is not used as the baseline.
 */
export function gateContext(editor: EditorState, history: VersionHistory): { openProposals: number; currentVersionId: string; history: VersionHistory } {
  const latest = latestVersion(history);
  if (!latest) throw new Error("no version committed yet");
  return { openProposals: openProposals(editor).length, currentVersionId: latest.id, history };
}
