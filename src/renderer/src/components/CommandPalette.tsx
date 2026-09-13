import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { Modal } from "./Modal";
import { useI18n } from "../i18n/I18nProvider";

export interface Command {
  id: string;
  title: string;
  icon?: IconName;
  /** Shortcut spec like "mod+shift+p"; rendered for the user's platform and language. */
  shortcut?: string;
  run: () => void;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

export function CommandPalette({ commands, onClose }: Props) {
  const { t, shortcut } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return commands;
    return commands.filter((c) => {
      const title = c.title.toLocaleLowerCase();
      return words.every((w) => title.includes(w));
    });
  }, [commands, query]);

  useEffect(() => setSelected(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector(".palette-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const execute = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  return (
    <Modal onClose={onClose} position="top" className="palette" label={t("palette.placeholder")}>
      <div className="palette-search">
        <Icon name="command" size={15} />
        <input
          autoFocus
          className="palette-input"
          placeholder={t("palette.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
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
          role="combobox"
          aria-expanded="true"
          aria-controls="command-list"
        />
      </div>
      <div className="palette-list" id="command-list" role="listbox" ref={listRef}>
        {filtered.map((cmd, i) => (
          <div
            key={cmd.id}
            role="option"
            aria-selected={i === selected}
            className={`palette-item${i === selected ? " selected" : ""}`}
            onMouseMove={() => setSelected(i)}
            onClick={() => execute(cmd)}
          >
            <Icon name={cmd.icon ?? "chevronRight"} size={14} flipRtl={!cmd.icon} />
            <span className="palette-primary">{cmd.title}</span>
            {cmd.shortcut && <kbd>{shortcut(cmd.shortcut)}</kbd>}
          </div>
        ))}
        {filtered.length === 0 && <div className="empty-note padded">{t("palette.empty")}</div>}
      </div>
    </Modal>
  );
}
