import { useState } from "react";
import type { ReactNode } from "react";
import { highlightCode } from "./Highlight";

/**
 * Minimal markdown for agent chat: fenced code blocks, inline code, bold,
 * and headings. No dependencies — the output is a list of blocks.
 */

type Block =
  | { kind: "code"; lang: string; code: string }
  | { kind: "text"; content: string };

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const fence = /```(\w*)\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > last) {
      blocks.push({ kind: "text", content: text.slice(last, match.index) });
    }
    blocks.push({ kind: "code", lang: match[1] || "text", code: match[2] });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    blocks.push({ kind: "text", content: text.slice(last) });
  }
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  // Split on `inline code`, **bold**, [text](url) and bare URLs; simple and safe.
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)`]+)/g).filter(Boolean);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} style={{ fontFamily: "var(--font-mono)", fontSize: "12px", background: "var(--bg-input)", padding: "1px 4px", borderRadius: 4 }}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    // [text](url) — only http(s) targets. target=_blank routes the click
    // through the main process's window-open handler into the system
    // browser; the Electron window itself never navigates.
    const mdLink = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(part);
    if (mdLink) {
      return (
        <a key={i} href={mdLink[2]} target="_blank" rel="noreferrer" className="chat-link" title={mdLink[2]}>
          {mdLink[1]}
        </a>
      );
    }
    if (/^https?:\/\/[^\s)`]+$/.test(part)) {
      return (
        <a key={i} href={part} target="_blank" rel="noreferrer" className="chat-link">
          {part}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

const INLINE_DIFF_VISIBLE = 12;

/** A ```diff fenced block: colored +/− lines, collapsed past a threshold. */
function DiffBlock({ code, lang }: { code: string; lang: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = code.replace(/\n$/, "").split("\n");
  const changed = lines.filter((l) => l.startsWith("+") || l.startsWith("-")).length;
  const shown = expanded ? lines : lines.slice(0, INLINE_DIFF_VISIBLE);
  const hidden = lines.length - shown.length;

  return (
    <div className="code-block diff-block">
      <div className="code-block-bar">
        <span>
          {lang} · <span className="d-add">+{lines.filter((l) => l.startsWith("+")).length}</span>
          {" "}<span className="d-del">−{lines.filter((l) => l.startsWith("-")).length}</span>
        </span>
        <CopyButton text={code} />
      </div>
      <pre>
        <code>
          {shown.map((line, i) => {
            const cls = line.startsWith("+")
              ? "dl-add"
              : line.startsWith("-")
                ? "dl-del"
                : line.startsWith("@@")
                  ? "dl-hunk"
                  : "dl-ctx";
            return (
              <div key={i} className={`diff-line-inline ${cls}`}>
                {line || " "}
              </div>
            );
          })}
        </code>
      </pre>
      {hidden > 0 && (
        <button className="diff-expand" onClick={() => setExpanded(true)}>
          show {hidden} more line{hidden === 1 ? "" : "s"} ({changed} changed)
        </button>
      )}
      {expanded && lines.length > INLINE_DIFF_VISIBLE && (
        <button className="diff-expand" onClick={() => setExpanded(false)}>collapse</button>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  return (
    <button
      className="copy-btn"
      onClick={() => {
        void navigator.clipboard.writeText(text);
      }}
      title="Copy"
    >
      copy
    </button>
  );
}

export function MarkdownLite({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === "code") {
          if (block.lang === "diff" || block.lang === "patch") {
            return <DiffBlock key={i} code={block.code} lang={block.lang} />;
          }
          return (
            <div key={i} className="code-block">
              <div className="code-block-bar">
                <span>{block.lang}</span>
                <CopyButton text={block.code} />
              </div>
              <pre>
                <code>{highlightCode(block.code, block.lang)}</code>
              </pre>
            </div>
          );
        }
        return (
          <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {block.content.split("\n").map((line, j) =>
              line.startsWith("### ") ? (
                <div key={j} style={{ fontWeight: 700, marginTop: 6 }}>{line.slice(4)}</div>
              ) : line.startsWith("## ") ? (
                <div key={j} style={{ fontWeight: 700, marginTop: 6 }}>{line.slice(3)}</div>
              ) : line.startsWith("# ") ? (
                <div key={j} style={{ fontWeight: 700, marginTop: 6 }}>{line.slice(2)}</div>
              ) : line.startsWith("- ") ? (
                <div key={j}>• {renderInline(line.slice(2))}</div>
              ) : (
                <div key={j}>{renderInline(line)}</div>
              ),
            )}
          </div>
        );
      })}
    </>
  );
}

export { CopyButton };
