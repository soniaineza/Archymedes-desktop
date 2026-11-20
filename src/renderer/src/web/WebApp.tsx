import { useState } from "react";
import { EnterpriseApp } from "../enterprise/EnterpriseApp";

/** The enterprise OS, plus a note where the desktop-only Workbench would open. */
export function WebApp() {
  const [workbench, setWorkbench] = useState(false);
  return (
    <>
      <EnterpriseApp edition="web" onOpenWorkbench={() => setWorkbench(true)} />
      {workbench && (
        <div className="web-note" role="dialog" aria-modal="true" aria-label="Workbench">
          <div className="web-note-card">
            <h2>The Workbench is desktop-only</h2>
            <p>The coding-agent workbench runs local shells and edits files, so it ships in the Archymedes Desktop app, not on the web.</p>
            <p>This web edition runs the full enterprise OS in your browser. Your workspace is stored only in this browser.</p>
            <button type="button" onClick={() => setWorkbench(false)}>
              Back to the OS
            </button>
          </div>
        </div>
      )}
    </>
  );
}
