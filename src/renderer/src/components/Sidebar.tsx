import { useEffect, useState } from "react";
import type { EditSummary, FileNode } from "@shared/types";

interface Props {
  tree: FileNode[];
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
  onOpenSearch: () => void;
  onOpenDiff: (path: string) => void;
}

function TreeItem({
  node, depth, activePath, onOpenFile,
}: {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);

  const icon = node.kind === "dir" ? (open ? "▾" : "▸") : " ";

  return (
    <>
      <div
        className={`tree-item${activePath === node.path ? " active" : ""}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => (node.kind === "dir" ? setOpen(!open) : onOpenFile(node.path))}
        title={node.path}
      >
        <span className="icon">{icon}</span>
        <span>{node.name}</span>
      </div>
      {node.kind === "dir" &&
        open &&
        node.children?.map((child) => (
          <TreeItem key={child.path} node={child} depth={depth + 1} activePath={activePath} onOpenFile={onOpenFile} />
        ))}
    </>
  );
}

export function Sidebar({ tree, activePath, onOpenFile, onOpenSearch, onOpenDiff }: Omit<Props, "onRefresh">) {
  const [edits, setEdits] = useState<EditSummary[]>([]);

  const loadEdits = () => {
    void window.archymedes.listEdits().then(setEdits);
  };
  useEffect(loadEdits, []);

  return (
    <div className="sidebar">
      <h2>
        explorer
        <span className="header-actions">
          <button className="icon-btn" onClick={onOpenSearch} title="Search in files (Ctrl+Shift+F)">⌕</button>
          <button className="icon-btn" onClick={loadEdits} title="Refresh">⟳</button>
        </span>
      </h2>
      <div className="tree-scroll">
        {tree.map((node) => (
          <TreeItem key={node.path} node={node} depth={0} activePath={activePath} onOpenFile={onOpenFile} />
        ))}
        {tree.length === 0 && (
          <div style={{ color: "var(--text-faint)", padding: "6px 12px", fontSize: 12 }}>Empty workspace</div>
        )}
      </div>

      <div className="edits-box">
        <h2>agent edits</h2>
        {edits.length === 0 && (
          <div style={{ color: "var(--text-faint)", padding: "2px 12px 6px", fontSize: 11 }}>
            No agent edits yet
          </div>
        )}
        {edits.map((edit) => (
          <div key={edit.path} className="edit-row" onClick={() => onOpenDiff(edit.path)} title={`${edit.path} — click to view diff`}>
            <span className="name">{edit.path}</span>
            <span className="stat-add">+{edit.added}</span>
            <span className="stat-del">−{edit.removed}</span>
            <button
              className="edit-btn"
              title="Revert this file"
              onClick={(e) => {
                e.stopPropagation();
                void window.archymedes.revertFile(edit.path).then(loadEdits);
              }}
            >
              ⎌
            </button>
            <button className="edit-btn" title="View diff" onClick={(e) => { e.stopPropagation(); onOpenDiff(edit.path); }}>
              ±
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
