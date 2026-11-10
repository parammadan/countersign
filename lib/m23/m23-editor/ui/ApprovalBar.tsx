import type { ApprovalStatus } from "../approval";

export type BarAction = { enabled: boolean; reason?: string };
export const statusText: Record<ApprovalStatus, string> = {
  draft: "Draft", pending_approval: "Waiting for approval", approved: "Approved", published: "Published",
};

/** Pure props-in bar. `actions` comes from `availableActions()`; disabled buttons explain themselves. */
export function ApprovalBar(props: {
  status: ApprovalStatus;
  actions: { submit: BarAction; approve: BarAction; requestChanges: BarAction; publish: BarAction };
  onSubmit?: () => void;
  onApprove?: () => void;
  onRequestChanges?: () => void;
  onPublish?: () => void;
}) {
  const btn = (label: string, a: BarAction, fn?: () => void) => (
    <button type="button" disabled={!a.enabled} title={a.enabled ? undefined : a.reason} onClick={fn}>{label}</button>
  );
  return (
    <div className="approval-bar" role="group" aria-label="Approval">
      <span className="approval-status" data-status={props.status}>{statusText[props.status]}</span>
      {props.status === "draft" && btn("Submit for approval", props.actions.submit, props.onSubmit)}
      {props.status === "pending_approval" && btn("Approve", props.actions.approve, props.onApprove)}
      {props.status === "pending_approval" && btn("Request changes", props.actions.requestChanges, props.onRequestChanges)}
      {props.status === "approved" && btn("Publish", props.actions.publish, props.onPublish)}
    </div>
  );
}
