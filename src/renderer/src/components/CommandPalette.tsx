import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  title: string;
  hint?: string;
  run: () => void;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [commands, query]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const execute = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter") {
              e.preventDefault();
              execute(filtered[selected]);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            }
          }}
        />
        <div className="palette-list">
          {filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`palette-item${i === selected ? " selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => execute(cmd)}
            >
              <span>{cmd.title}</span>
              {cmd.hint && <span className="hint">{cmd.hint}</span>}
            </div>
          ))}
          {filtered.length === 0 && <div className="palette-empty">No matching commands</div>}
        </div>
      </div>
    </div>
  );
}
