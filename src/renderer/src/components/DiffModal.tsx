import { useEffect, useState } from "react";
import type { FileDiff } from "@shared/types";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { useToast } from "./Toasts";
import { useI18n } from "../i18n/I18nProvider";

interface Props {
  path: string;
  onClose: () => void;
  onReverted: () => void;
  onOpenFile: (path: string) => void;
}

export function DiffModal({ path, onClose, onReverted, onOpenFile }: Props) {
  const { t, formatNumber } = useI18n();
  const notify = useToast();
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [reverting, setReverting] = useState(false);

  useEffect(() => {
    let alive = true;
    setState("loading");
    window.archymedes
      .diffFile(path)
      .then((d) => {
        if (!alive) return;
        setDiff(d);
        setState("ready");
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setState("error");
      });
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const hasChanges = Boolean(diff && (diff.added > 0 || diff.removed > 0));

  const revert = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setReverting(true);
    try {
      await window.archymedes.revertFile(path);
      notify(t("sidebar.reverted", { path }), "success");
      onReverted();
      onClose();
    } catch (err) {
      notify(t("common.error", { error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      setReverting(false);
    }
  };

  return (
    <Modal onClose={onClose} labelledBy="diff-title" className="diff-modal">
      <div className="modal-header">
        <div className="diff-heading">
          <h2 id="diff-title">
            <bdi dir="ltr">{path}</bdi>
          </h2>
          {diff && (
            <div className="diff-stats">
              {diff.isNew && <span className="pill success">{t("diff.newFile")}</span>}
              <span className="stat-add">+{formatNumber(diff.added)}</span>
              <span className="stat-del">−{formatNumber(diff.removed)}</span>
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn small" onClick={() => onOpenFile(path)}>
            <Icon name="external" size={13} />
            {t("diff.openFile")}
          </button>
          <button
            className={`btn small danger${confirming ? " confirming" : ""}`}
            onClick={() => void revert()}
            disabled={reverting || !hasChanges}
          >
            <Icon name="undo" size={13} />
            {confirming ? t("diff.confirmRevert") : t("diff.revert")}
          </button>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}>
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>

      {state === "loading" && <div className="empty-note padded">{t("diff.loading")}</div>}
      {state === "error" && (
        <div className="callout error">
          <Icon name="alert" size={15} />
          <span>{t("common.error", { error: errorMessage })}</span>
        </div>
      )}
      {state === "ready" && !diff && <div className="empty-note padded">{t("diff.noSnapshot")}</div>}
      {diff && (
        <div className="diff-body" dir="ltr">
          {diff.lines.map((line, i) => (
            <div key={i} className={`diff-line ${line.kind}`}>
              <span className="ln">{line.kind === "del" ? (line.oldLine ?? "") : (line.newLine ?? "")}</span>
              <span className="sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>
              <span className="code">{line.text}</span>
            </div>
          ))}
          {diff.lines.length === 0 && (
            <div className="empty-note padded" dir="auto">
              {t("diff.noChanges")}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
