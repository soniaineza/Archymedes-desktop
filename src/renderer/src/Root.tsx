import { useState } from "react";
import App from "./App";
import { EnterpriseApp } from "./enterprise/EnterpriseApp";

const MODE_KEY = "archymedes.mode";
type Mode = "enterprise" | "workbench";

function initialMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "workbench" ? "workbench" : "enterprise";
  } catch {
    return "enterprise";
  }
}

/**
 * Archymedes Desktop opens on the enterprise OS. The original coding-agent IDE
 * stays one click away as the Workbench — the local executor for approved work.
 */
export function Root() {
  const [mode, setMode] = useState<Mode>(initialMode);
  const switchTo = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* convenience only */
    }
  };
  if (mode === "enterprise") return <EnterpriseApp onOpenWorkbench={() => switchTo("workbench")} />;
  return (
    <>
      <App />
      <button type="button" className="ent-back" onClick={() => switchTo("enterprise")} title="Back to the enterprise OS">
        ← Archymedes OS
      </button>
    </>
  );
}
