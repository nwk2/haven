import { Button } from "@haven/ui";
import { useSession } from "../session";

/** Global sync states (canvas › System states). */
export function SyncPill() {
  const { status } = useSession();
  if (status.state === "too_old") {
    return (
      <div className="h-toast" role="alert">
        <strong>Update Haven to keep syncing</strong>
        <span>This version is too old to sync. You can keep using what’s on this phone; {status.pending} unsent changes are safe and will sync after the update.</span>
        <div><Button variant="secondary" onClick={() => location.reload()}>Update now</Button></div>
      </div>
    );
  }
  if (status.state === "error") return <div className="h-pill h-pill--warn" role="alert"><span className="h-pill__dot" />Can’t sync right now · retrying{status.pending ? ` · ${status.pending} changes saved on this phone` : ""}</div>;
  if (status.state === "offline") return <div className="h-pill" role="status"><span className="h-pill__dot" />Offline · changes are saved on this phone</div>;
  if (status.state === "syncing" && status.pending > 0) return <div className="h-pill" role="status"><span className="h-pill__dot" />Syncing {status.pending} changes…</div>;
  return null;
}
