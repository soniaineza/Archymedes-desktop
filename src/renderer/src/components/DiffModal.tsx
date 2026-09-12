import { useEffect, useState } from "react";
import type { FileDiff } from "@shared/types";

interface Props {
  path: string;
  onClose: () => void;
  onReverted: () => void;
  onOpenFile: (path: string) => void;
}

/** Reverts at or above this many changed lines ask for confirmation first. */
const CONFIRM_THRESHOLD = 40;

export function DiffModal({ path, onClose, onReverted, onOpenFile }: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [reverting, setReverting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setLoading(true);
    void window.archymedes.diffFile(path).then((d) => {
      setDiff(d);
      setLoading(false);
    });
  }, [path]);

  // Escape closes the modal (unless a revert or confirmation is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !reverting && !confirming) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, reverting, confirming]);

  const changed = diff ? diff.added + diff.removed : 0;
  const needsConfirm = changed >= CONFIRM_THRESHOLD;

  const revert = async () => {
    setReverting(true);
    try {
      await window.archymedes.revertFile(path);
      onReverted();
      onClose();
    } finally {
      setReverting(false);
    }
  };

  const onRevertClick = () => {
    if (needsConfirm && !confirming) {
      setConfirming(true);
      return;
    }
    void revert();
  };

  return (
    <div className="modal-backdrop" onClick={() => !confirming && onClose()}>
      <div className="modal diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diff-header">
          <div>
            <div className="diff-title">{path}</div>
            {diff && (
              <div className="diff-stats">
                {diff.isNew && <span className="badge new">new file</span>}
                <span className="added">+{diff.added}</span>
                <span className="removed">−{diff.removed}</span>
              </div>
            )}
          </div>
          <div className="diff-actions">
            <button className="ghost" onClick={() => onOpenFile(path)}>open file</button>
            <button
              className="danger"
              onClick={onRevertClick}
              disabled={reverting || !diff || changed === 0}
            >
              revert
            </button>
            <button className="ghost" onClick={onClose}>close</button>
          </div>
        </div>

        {confirming && (
          <div className="revert-confirm" role="alertdialog">
            <span>
              Revert <b>{changed}</b> changed line{changed === 1 ? "" : "s"} in{" "}
              <b>{path.split("/").pop()}</b>? The agent's edits to this file will be undone.
            </span>
            <span className="revert-confirm-actions">
              <button className="ghost" onClick={() => setConfirming(false)}>cancel</button>
              <button className="danger" onClick={() => void revert()} disabled={reverting}>
                {reverting ? "reverting…" : "yes, revert"}
              </button>
            </span>
          </div>
        )}

        {loading && <div className="diff-note">loading diff…</div>}
        {!loading && !diff && (
          <div className="diff-note">No snapshot for this file — the agent has not edited it in this workspace session.</div>
        )}
        {diff && (
          <div className="diff-body">
            {diff.lines.map((line, i) => (
              <div key={i} className={`diff-line ${line.kind}`}>
                <span className="ln">{line.kind === "del" ? line.oldLine ?? "" : line.newLine ?? ""}</span>
                <span className="sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
                <span className="code">{line.text}</span>
              </div>
            ))}
            {diff.lines.length === 0 && <div className="diff-note">No changes — file content matches its snapshot.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
