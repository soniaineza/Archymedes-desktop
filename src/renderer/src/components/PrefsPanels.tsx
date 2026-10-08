import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "../i18n/I18nProvider";
import {
  AUTO_SAVE_DELAY_RANGE,
  CHAT_PREF_KEYS,
  EDITOR_PREF_KEYS,
  FONT_SIZE_RANGE,
  GENERAL_PREF_KEYS,
  TAB_SIZES,
  resetPrefs,
  setPref,
  usePrefs,
} from "../lib/prefs";
import type { AutoSaveMode, Prefs, SendKey } from "../lib/prefs";
import { highlightCode } from "./Highlight";
import { Icon } from "./Icon";

/**
 * Settings tabs for the client-side preferences in lib/prefs.ts. Unlike the provider
 * settings these apply instantly (like the theme), so there is nothing to "Save".
 */

type BoolKey = { [K in keyof Prefs]: Prefs[K] extends boolean ? K : never }[keyof Prefs];

function Toggle({ prefKey, label, hint }: { prefKey: BoolKey; label: string; hint?: string }) {
  const prefs = usePrefs();
  const id = `pref-${prefKey}`;
  return (
    <label className="toggle-row" htmlFor={id}>
      <input id={id} type="checkbox" checked={prefs[prefKey]} onChange={(e) => setPref(prefKey, e.target.checked)} />
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
    </label>
  );
}

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

/** A number box that only commits valid values (and clamps them) when you leave it or press Enter. */
function NumberPref({ id, value, min, max, step, onCommit }: {
  id: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n) && text.trim() !== "") onCommit(Math.min(max, Math.max(min, Math.round(n))));
    else setText(String(value));
  };
  return (
    <input
      id={id}
      className="input narrow"
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

function ResetButton({ keys }: { keys: readonly (keyof Prefs)[] }) {
  const { t } = useI18n();
  return (
    <button className="btn small settings-reset" onClick={() => resetPrefs(keys)}>
      <Icon name="undo" size={13} />
      {t("settings.resetDefaults")}
    </button>
  );
}

const PREVIEW = `// Preview
import { readFile } from "node:fs/promises";

export async function load(path: string): Promise<Config> {
  const text = await readFile(path, "utf8");
  if (!text) return { name: "default", retries: 3 };
  return JSON.parse(text) as Config;
}`;

export function EditorPrefsPanel() {
  const { t } = useI18n();
  const prefs = usePrefs();
  return (
    <>
      <Field label={t("settings.autoSave")} hint={t("settings.autoSaveHint")} htmlFor="pref-autosave">
        <select
          id="pref-autosave"
          className="input"
          value={prefs.autoSave}
          onChange={(e) => setPref("autoSave", e.target.value as AutoSaveMode)}
        >
          <option value="off">{t("settings.autoSaveOff")}</option>
          <option value="afterDelay">{t("settings.autoSaveAfterDelay")}</option>
          <option value="onFocusChange">{t("settings.autoSaveOnFocusChange")}</option>
        </select>
      </Field>
      {prefs.autoSave === "afterDelay" && (
        <Field label={t("settings.autoSaveDelay")} hint={t("settings.autoSaveDelayHint")} htmlFor="pref-autosave-delay">
          <NumberPref
            id="pref-autosave-delay"
            value={prefs.autoSaveDelay}
            min={AUTO_SAVE_DELAY_RANGE.min}
            max={AUTO_SAVE_DELAY_RANGE.max}
            step={100}
            onCommit={(v) => setPref("autoSaveDelay", v)}
          />
        </Field>
      )}
      <div className="input-row">
        <Field label={t("settings.fontSize")} htmlFor="pref-font-size">
          <NumberPref
            id="pref-font-size"
            value={prefs.editorFontSize}
            min={FONT_SIZE_RANGE.min}
            max={FONT_SIZE_RANGE.max}
            onCommit={(v) => setPref("editorFontSize", v)}
          />
        </Field>
        <Field label={t("settings.tabSize")} htmlFor="pref-tab-size">
          <select
            id="pref-tab-size"
            className="input narrow"
            value={prefs.editorTabSize}
            onChange={(e) => setPref("editorTabSize", Number(e.target.value))}
          >
            {TAB_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="toggle-group">
        <Toggle prefKey="editorWordWrap" label={t("settings.wordWrap")} hint={t("settings.wordWrapHint")} />
        <Toggle prefKey="editorLineNumbers" label={t("settings.lineNumbers")} />
        <Toggle prefKey="bracketColors" label={t("settings.bracketColors")} hint={t("settings.bracketColorsHint")} />
      </div>
      <div className="code-block" dir="ltr" aria-hidden>
        <pre style={{ fontSize: prefs.editorFontSize, tabSize: prefs.editorTabSize }}>
          <code>{highlightCode(PREVIEW, "ts")}</code>
        </pre>
      </div>
      <ResetButton keys={EDITOR_PREF_KEYS} />
    </>
  );
}

export function ChatPrefsPanel() {
  const { t, shortcut } = useI18n();
  const prefs = usePrefs();
  return (
    <>
      <Field label={t("settings.sendKey")} htmlFor="pref-send-key">
        <select
          id="pref-send-key"
          className="input"
          value={prefs.chatSendKey}
          onChange={(e) => setPref("chatSendKey", e.target.value as SendKey)}
        >
          <option value="enter">{t("settings.sendKeyEnter", { newline: shortcut("shift+Enter") })}</option>
          <option value="ctrlEnter">{t("settings.sendKeyCtrlEnter", { send: shortcut("mod+Enter") })}</option>
        </select>
      </Field>
      <div className="toggle-group">
        <Toggle prefKey="codeLineNumbers" label={t("settings.codeLineNumbers")} />
        <Toggle prefKey="codeWordWrap" label={t("settings.codeWordWrap")} hint={t("settings.codeWordWrapHint")} />
        <Toggle prefKey="showTokenUsage" label={t("settings.showTokenUsage")} hint={t("settings.showTokenUsageHint")} />
      </div>
      <ResetButton keys={CHAT_PREF_KEYS} />
    </>
  );
}

/** Extra toggles shown on the General tab. */
export function GeneralPrefsSection() {
  const { t } = useI18n();
  return (
    <>
      <div className="toggle-group">
        <div className="settings-section-title">{t("settings.behaviour")}</div>
        <Toggle prefKey="restoreLastChat" label={t("settings.restoreLastChat")} hint={t("settings.restoreLastChatHint")} />
        <Toggle prefKey="confirmCloseDirty" label={t("settings.confirmCloseDirty")} />
        <Toggle prefKey="reduceMotion" label={t("settings.reduceMotion")} hint={t("settings.reduceMotionHint")} />
      </div>
      <ResetButton keys={GENERAL_PREF_KEYS} />
    </>
  );
}
