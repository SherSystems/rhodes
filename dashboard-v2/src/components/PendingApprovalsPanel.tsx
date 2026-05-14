/**
 * Pending Approvals Panel — rendered above the page content on every tab.
 *
 * v0.4.5 feature parity: the operator should never have to navigate
 * elsewhere to clear a gate. The panel hides itself entirely when nothing
 * is awaiting decision so it never reads as "empty noise."
 */

import { useStore } from "../store";
import Approvals from "./Approvals";

export default function PendingApprovalsPanel() {
  const pending = useStore((s) => s.pendingApprovals);
  if (pending.length === 0) return null;

  return (
    <section className="pending-approvals-panel" aria-label="Pending approvals">
      <header className="pending-approvals-panel-header">
        <span className="pending-approvals-panel-title">Pending Approvals</span>
        <span className="pending-approvals-panel-count">
          {pending.length}
          <span className="pending-approvals-panel-count-suffix">
            {pending.length === 1 ? " awaiting decision" : " awaiting decision"}
          </span>
        </span>
      </header>
      <Approvals compact />
    </section>
  );
}
