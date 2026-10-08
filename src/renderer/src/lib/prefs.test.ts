import { beforeEach, describe, expect, it } from "vitest";
import { applyPrefsToDocument, DEFAULT_PREFS, getPrefs, parsePrefs, reloadPrefs, resetPrefs, setPref } from "./prefs";

beforeEach(() => reloadPrefs());

describe("prefs", () => {
  it("starts from the defaults", () => {
    expect(getPrefs()).toEqual(DEFAULT_PREFS);
    expect(getPrefs().showTokenUsage).toBe(true);
    expect(getPrefs().restoreLastChat).toBe(true);
    expect(getPrefs().autoSave).toBe("off");
    expect(getPrefs().autoSaveDelay).toBe(1000);
  });

  it("drops invalid stored values field by field", () => {
    const parsed = parsePrefs({ autoSave: "sometimes", editorFontSize: 99, editorTabSize: 3, codeWordWrap: true, extra: 1 });
    expect(parsed.autoSave).toBe("off");
    expect(parsed.editorFontSize).toBe(24);
    expect(parsed.editorTabSize).toBe(2);
    expect(parsed.codeWordWrap).toBe(true);
    expect(parsed).not.toHaveProperty("extra");
    expect(parsePrefs("garbage")).toEqual(DEFAULT_PREFS);
  });

  it("persists changes and survives a reload", () => {
    setPref("autoSave", "afterDelay");
    setPref("editorTabSize", 4);
    reloadPrefs();
    expect(getPrefs().autoSave).toBe("afterDelay");
    expect(getPrefs().editorTabSize).toBe(4);
  });

  it("resets only the requested keys", () => {
    setPref("autoSave", "onFocusChange");
    setPref("chatSendKey", "ctrlEnter");
    resetPrefs(["autoSave"]);
    expect(getPrefs().autoSave).toBe("off");
    expect(getPrefs().chatSendKey).toBe("ctrlEnter");
  });

  it("reflects CSS-driven preferences on the document", () => {
    const root = document.createElement("div");
    applyPrefsToDocument({ ...DEFAULT_PREFS, codeLineNumbers: true, reduceMotion: true, editorFontSize: 15 }, root);
    expect(root.dataset.codeLineNumbers).toBe("on");
    expect(root.dataset.reduceMotion).toBe("on");
    expect(root.dataset.codeWrap).toBe("off");
    expect(root.style.getPropertyValue("--editor-font-size")).toBe("15px");
    expect(root.style.getPropertyValue("--editor-line-height")).toBe("24px");
  });
});
