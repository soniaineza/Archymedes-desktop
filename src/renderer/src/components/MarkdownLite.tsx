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
  // Split on `inline code` and **bold**; keep it simple and safe.
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
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
    return <span key={i}>{part}</span>;
  });
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
