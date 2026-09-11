import { useCallback, useEffect, useState } from "react";
import type { EditSummary, FileNode } from "@shared/types";
import { Icon } from "./Icon";
import { useToast } from "./Toasts";
import { useI18n } from "../i18n/I18nProvider";
import { fileKind } from "../lib/files";

interface Props {
  tree: FileNode[];
  activePath: string | null;
  /** Bumped when files change on disk, so the edits list stays current. */
  editTick: number;
  onOpenFile: (path: string) => void;
  onOpenSearch: () => void;
  onOpenDiff: (path: string) => void;
  onReverted: (path: string) => void;
}

function TreeItem({ node, depth, activePath, onOpenFile }: {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const isDir = node.kind === "dir";
  const active = activePath === node.path;

  return (
    <li role="treeitem" aria-expanded={isDir ? open : undefined} aria-selected={active}>
      <button
        className={`tree-item${active ? " active" : ""}`}
        style={{ paddingInlineStart: 8 + depth * 14 }}
        onClick={() => (isDir ? setOpen((o) => !o) : onOpenFile(node.path))}
        title={node.path}
      >
        {isDir ? (
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} flipRtl className="tree-chevron" />
        ) : (
          <span className="tree-chevron" />
        )}
        <Icon
          name={isDir ? "folder" : "file"}
          size={14}
          className={`tree-icon ${isDir ? "kind-folder" : `kind-${fileKind(node.name)}`}`}
        />
        <bdi className="tree-name">{node.name}</bdi>
      </button>
      {isDir && open && node.children && node.children.length > 0 && (
        <ul role="group">
          {node.children.map((child) => (
            <TreeItem key={child.path} node={child} depth={depth + 1} activePath={activePath} onOpenFile={onOpenFile} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Sidebar({ tree, activePath, editTick, onOpenFile, onOpenSearch, onOpenDiff, onReverted }: Props) {
  const { t, formatNumber, shortcut } = useI18n();
  const notify = useToast();
  const [edits, setEdits] = useState<EditSummary[]>([]);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);

  const loadEdits = useCallback(() => {
    void window.archymedes
      .listEdits()
      .then(setEdits)
      .catch(() => setEdits([]));
  }, []);

  useEffect(loadEdits, [loadEdits, editTick]);

  useEffect(() => {
    if (!confirmPath) return;
    const timer = setTimeout(() => setConfirmPath(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmPath]);

  const revert = async (path: string) => {
    try {
      await window.archymedes.revertFile(path);
      notify(t("sidebar.reverted", { path }), "success");
      onReverted(path);
      loadEdits();
    } catch (err) {
      notify(t("common.error", { error: err instanceof Error ? err.message : String(err) }), "error");
    }
  };

  return (
    <nav className="sidebar" aria-label={t("sidebar.explorer")}>
      <div className="panel-header">
        <span className="panel-title">{t("sidebar.explorer")}</span>
        <span className="panel-actions">
          <button
            className="icon-btn"
            onClick={onOpenSearch}
            title={`${t("sidebar.search")} (${shortcut("mod+shift+f")})`}
            aria-label={t("sidebar.search")}
          >
            <Icon name="search" size={14} />
          </button>
          <button className="icon-btn" onClick={loadEdits} title={t("common.refresh")} aria-label={t("common.refresh")}>
            <Icon name="refresh" size={14} />
          </button>
        </span>
      </div>

      <div className="tree-scroll">
        {tree.length > 0 ? (
          <ul className="tree" role="tree" aria-label={t("sidebar.explorer")}>
            {tree.map((node) => (
              <TreeItem key={node.path} node={node} depth={0} activePath={activePath} onOpenFile={onOpenFile} />
            ))}
          </ul>
        ) : (
          <div className="empty-note">{t("sidebar.emptyWorkspace")}</div>
        )}
      </div>

      <section className="edits-box" aria-label={t("sidebar.agentEdits")}>
        <div className="panel-header">
          <span className="panel-title">{t("sidebar.agentEdits")}</span>
          {edits.length > 0 && <span className="count-badge">{formatNumber(edits.length)}</span>}
        </div>
        {edits.length === 0 ? (
          <div className="empty-note">{t("sidebar.noEdits")}</div>
        ) : (
          <div className="edits-list">
            {edits.map((edit) => {
              const confirming = confirmPath === edit.path;
              return (
                <div key={edit.path} className="edit-row">
                  <button className="edit-open" onClick={() => onOpenDiff(edit.path)} title={`${edit.path} · ${t("sidebar.viewDiff")}`}>
                    <bdi className="name" dir="ltr">
                      {edit.path}
                    </bdi>
                    <span className="stat-add">+{formatNumber(edit.added)}</span>
                    <span className="stat-del">−{formatNumber(edit.removed)}</span>
                  </button>
                  <button
                    className={`icon-btn${confirming ? " confirming" : ""}`}
                    title={confirming ? t("sidebar.confirmRevert") : t("sidebar.revert")}
                    aria-label={confirming ? t("sidebar.confirmRevert") : t("sidebar.revert")}
                    onClick={() => {
                      if (confirming) {
                        setConfirmPath(null);
                        void revert(edit.path);
                      } else {
                        setConfirmPath(edit.path);
                      }
                    }}
                  >
                    <Icon name="undo" size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </nav>
  );
}
