import { useEffect, useState } from "react";
import type { FileDiff } from "@shared/types";

interface Props {
  path: string;
  onClose: () => void;
  onReverted: () => void;
  onOpenFile: (path: string) => void;
}

export function DiffModal({ path, onClose, onReverted, onOpenFile }: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [reverting, setReverting] = useState(false);

  useEffect(() => {
    setLoading(true);
    void window.archymedes.diffFile(path).then((d) => {
      setDiff(d);
      setLoading(false);
    });
  }, [path]);

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

  return (
    <div className="modal-backdrop" onClick={onClose}>
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
            <button className="danger" onClick={() => void revert()} disabled={reverting || !diff || (diff.added === 0 && diff.removed === 0)}>
              revert
            </button>
            <button className="ghost" onClick={onClose}>close</button>
          </div>
        </div>

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
