import { useEffect, useState } from "react";
import { HeroCanvas } from "./HeroCanvas";

interface Props {
  onPick: () => void;
  onOpenPath: (path: string) => void;
}

const RECENT_KEY = "archymedes.recent-workspaces";

export function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function pushRecent(path: string): void {
  try {
    const list = readRecent().filter((p) => p !== path);
    list.unshift(path);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5)));
  } catch {
    // storage unavailable; recents are a nicety, not a requirement
  }
}

const STEPS = [
  { n: "1", title: "Open a folder", desc: "any project on your machine — nothing is uploaded" },
  { n: "2", title: "Add your API key", desc: "Anthropic, OpenAI, Ollama, OpenRouter, Groq — stored locally" },
  { n: "3", title: "Just ask", desc: "the agent reads, edits and runs — every edit is diffable and revertible" },
];

export function Welcome({ onPick, onOpenPath }: Props) {
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    setRecent(readRecent());
  }, []);

  return (
    <div className="welcome">
      <div className="hero-canvas-host" aria-hidden>
        <HeroCanvas />
      </div>

      <div className="welcome-content">
        <div className="wordmark">
          <span className="mark">▣</span>
          <h1>ARCHYMEDES</h1>
        </div>
        <p className="tagline">a coding agent that lives on your desktop</p>

        <div className="welcome-actions">
          <button className="primary" onClick={onPick}>
            Open Workspace…
          </button>
        </div>

        {recent.length > 0 && (
          <div className="recent">
            <div className="recent-label">recent workspaces</div>
            {recent.map((p) => (
              <button key={p} className="recent-item" onClick={() => onOpenPath(p)} title={p}>
                <span className="name">{p.split(/[\\/]/).pop()}</span>
                <span className="path">{p}</span>
              </button>
            ))}
          </div>
        )}

        <div className="steps">
          {STEPS.map((s) => (
            <div key={s.n} className="step">
              <span className="step-n">{s.n}</span>
              <div>
                <div className="step-title">{s.title}</div>
                <div className="step-desc">{s.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="welcome-foot">
          sessions · diff &amp; revert · multi-terminal · search · @file context
        </div>
      </div>
    </div>
  );
}
