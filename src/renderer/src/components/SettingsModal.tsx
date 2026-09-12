import { useEffect, useState } from "react";
import type { ProviderSettings } from "@shared/types";
import { DEFAULT_PROVIDER_SETTINGS, PROVIDER_LABELS, PROVIDER_DEFAULT_MODELS, PROVIDER_DEFAULT_BASE_URLS, TERMINAL_SHELL_LABELS, TERMINAL_SHELL_CHOICES } from "@shared/types";
import type { ProviderId, TerminalShellChoice } from "@shared/types";
import { THEMES, getTheme, applyTheme } from "../lib/theme";
import type { Theme } from "../lib/theme";

interface Props {
  onClose: () => void;
  onSaved: (settings: ProviderSettings) => void;
}

const PROVIDER_IDS = Object.keys(PROVIDER_LABELS) as ProviderId[];

export function SettingsModal({ onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<ProviderSettings>(DEFAULT_PROVIDER_SETTINGS);
  const [theme, setTheme] = useState<Theme>(getTheme());

  useEffect(() => {
    void window.archymedes.getSettings().then(setSettings);
  }, []);

  const pickTheme = (t: Theme) => {
    setTheme(t);
    applyTheme(t); // instant preview
  };

  const pickProvider = (id: ProviderId) => {
    setSettings((s) => ({
      ...s,
      provider: id,
      model: PROVIDER_DEFAULT_MODELS[id],
      baseUrl: PROVIDER_DEFAULT_BASE_URLS[id] ?? "",
    }));
  };

  const save = async () => {
    await window.archymedes.saveSettings(settings);
    onSaved(settings);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="field">
          <label>Theme</label>
          <select value={theme} onChange={(e) => pickTheme(e.target.value as Theme)}>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <div className="hint">Applies instantly. Also cycle themes with the button in the title bar.</div>
        </div>

        <h2>Provider</h2>

        <div className="field">
          <label>Provider</label>
          <select value={settings.provider} onChange={(e) => pickProvider(e.target.value as ProviderId)}>
            {PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {PROVIDER_LABELS[id]}
              </option>
            ))}
          </select>
          <div className="hint">
            {settings.provider === "anthropic"
              ? "Uses the Anthropic Messages API."
              : settings.provider === "ollama"
                ? "Local inference — no API key needed, just a running Ollama daemon."
                : "Speaks the OpenAI-compatible protocol, like every non-Anthropic provider in the CLI."}
          </div>
        </div>

        <div className="field">
          <label>Model</label>
          <input
            value={settings.model}
            onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
            placeholder={PROVIDER_DEFAULT_MODELS[settings.provider]}
          />
          <div className="hint">Budgets (context window, output ceiling) adapt automatically from the model id.</div>
        </div>

        <div className="field">
          <label>API key</label>
          <input
            type="password"
            value={settings.apiKey}
            onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
            placeholder={settings.provider === "ollama" ? "not required" : "your key"}
          />
        </div>

        <div className="field">
          <label>Base URL (optional override)</label>
          <input
            value={settings.baseUrl}
            onChange={(e) => setSettings((s) => ({ ...s, baseUrl: e.target.value }))}
            placeholder={PROVIDER_DEFAULT_BASE_URLS[settings.provider] ?? "provider default"}
          />
        </div>

        <div className="field">
          <label>Currency for cost display</label>
          <select value={settings.currency} onChange={(e) => setSettings((s) => ({ ...s, currency: e.target.value }))}>
            {["USD", "EUR", "RWF", "GBP", "JPY", "CAD", "AUD", "CHF", "INR", "BRL"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <div className="hint">
            Costs are priced from the CLI's dated per-model catalog; a model without a catalog entry reports “unpriced” rather than guessing.
          </div>
        </div>

        <div className="field">
          <label>Max tool-loop iterations</label>
          <input
            type="number"
            min={1}
            max={100}
            value={settings.maxIterations}
            onChange={(e) =>
              setSettings((s) => ({ ...s, maxIterations: Math.max(1, Number(e.target.value) || 1) }))
            }
          />
          <div className="hint">The CLI's own default is 100; lower values bound long tasks sooner.</div>
        </div>

        <h2>Terminal</h2>

        <div className="field">
          <label>Shell</label>
          <select
            value={settings.terminalShell ?? "default"}
            onChange={(e) =>
              setSettings((s) => ({ ...s, terminalShell: e.target.value as TerminalShellChoice }))
            }
          >
            {TERMINAL_SHELL_CHOICES.map((id) => (
              <option key={id} value={id}>{TERMINAL_SHELL_LABELS[id]}</option>
            ))}
          </select>
          <div className="hint">
            Default shell for new terminal tabs — each tab's ＋ menu can override it. If a shell
            isn't installed (e.g. Git Bash), the tab falls back to PowerShell and says so.
          </div>
        </div>

        {settings.terminalShell === "custom" && (
          <div className="field">
            <label>Shell executable path</label>
            <input
              value={settings.terminalShellPath ?? ""}
              onChange={(e) => setSettings((s) => ({ ...s, terminalShellPath: e.target.value }))}
              placeholder={process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/zsh"}
            />
            <div className="hint">Full path to any executable. Must exist at terminal creation.</div>
          </div>
        )}

        <div className="hint">
          Your key is stored locally and only sent to the provider endpoint above. It is stripped from
          the environment of every command the agent runs.
        </div>

        <div className="actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
