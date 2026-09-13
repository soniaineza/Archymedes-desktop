import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { highlightCode } from "./Highlight";
import { Icon } from "./Icon";
import { useI18n } from "../i18n/I18nProvider";

/**
 * Minimal, dependency-free markdown for agent chat: fenced code, headings,
 * lists, quotes, rules, inline code, bold, italic and web links. Prose blocks
 * use dir="auto" so right-to-left and left-to-right replies both read naturally.
 */

type Block = { kind: "code"; lang: string; code: string } | { kind: "text"; content: string };

function splitFences(text: string): Block[] {
  const blocks: Block[] = [];
  const fence = /```([\w+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    if (match.index > last) blocks.push({ kind: "text", content: text.slice(last, match.index) });
    blocks.push({ kind: "code", lang: match[1] || "text", code: match[2].replace(/\n$/, "") });
    last = match.index + match[0].length;
  }
  if (last < text.length) blocks.push({ kind: "text", content: text.slice(last) });
  return blocks;
}

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\s][^*\n]*\*)/g;

function renderInline(text: string): ReactNode[] {
  return text
    .split(INLINE)
    .filter(Boolean)
    .map((part, i) => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        return (
          <code key={i} className="inline-code">
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      }
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      if (link) {
        const [, label, href] = link;
        if (!/^https?:\/\//i.test(href)) return <span key={i}>{label}</span>;
        return (
          <a
            key={i}
            href={href}
            onClick={(e) => {
              e.preventDefault();
              window.open(href, "_blank", "noopener");
            }}
          >
            {label}
          </a>
        );
      }
      if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
        return <em key={i}>{part.slice(1, -1)}</em>;
      }
      return <Fragment key={i}>{part}</Fragment>;
    });
}

function renderProse(content: string): ReactNode[] {
  const out: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const lines = paragraph;
    out.push(
      <p key={out.length} dir="auto">
        {lines.map((line, i) => (
          <Fragment key={i}>
            {i > 0 && <br />}
            {renderInline(line)}
          </Fragment>
        ))}
      </p>,
    );
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const { ordered, items } = list;
    const children = items.map((item, i) => <li key={i}>{renderInline(item)}</li>);
    out.push(
      ordered ? (
        <ol key={out.length} dir="auto">
          {children}
        </ol>
      ) : (
        <ul key={out.length} dir="auto">
          {children}
        </ul>
      ),
    );
    list = null;
  };

  for (const line of content.split("\n")) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);

    if (heading) {
      flushParagraph();
      flushList();
      out.push(
        <div key={out.length} className={`md-heading level-${heading[1].length}`} dir="auto">
          {renderInline(heading[2])}
        </div>,
      );
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph();
      flushList();
      out.push(<hr key={out.length} />);
    } else if (quote) {
      flushParagraph();
      flushList();
      out.push(
        <blockquote key={out.length} dir="auto">
          {renderInline(quote[1])}
        </blockquote>,
      );
    } else if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return out;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      className={`copy-btn${copied ? " copied" : ""}`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
      title={label ?? t("common.copy")}
    >
      <Icon name={copied ? "check" : "copy"} size={12} />
      <span>{copied ? t("common.copied") : t("common.copy")}</span>
    </button>
  );
}

export function MarkdownLite({ text }: { text: string }) {
  return (
    <>
      {splitFences(text).map((block, i) =>
        block.kind === "code" ? (
          <div key={i} className="code-block" dir="ltr">
            <div className="code-block-bar">
              <span>{block.lang}</span>
              <CopyButton text={block.code} />
            </div>
            <pre>
              <code>{highlightCode(block.code, block.lang)}</code>
            </pre>
          </div>
        ) : (
          <Fragment key={i}>{renderProse(block.content)}</Fragment>
        ),
      )}
    </>
  );
}
