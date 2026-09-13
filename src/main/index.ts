import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { registerIpc } from "./ipc";
import { electronIpcHost } from "./ipc-host";
import type { HostBridge } from "./ipc-host";
import { createServices } from "./services";

// Handle creating/destroying single-instance behavior on Windows
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    backgroundColor: "#0b0b0d",
    title: "Archymedes Desktop",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses Electron IPC APIs
      spellcheck: false,
    },
  });

  // Only web links go to the OS: file:// or custom schemes could launch local programs.
  const openIfWebLink = (url: string): void => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openIfWebLink(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === mainWindow?.webContents.getURL()) return;
    event.preventDefault();
    openIfWebLink(url);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** The IPC layer's view of Electron: a folder picker and a way to push events to windows. */
function electronBridge(): HostBridge {
  return {
    async pickDirectory(title) {
      const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"], title };
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    emit(channel, ...payload) {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, ...payload);
    },
  };
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

void app.whenReady().then(() => {
  const services = createServices({ userData: app.getPath("userData") });
  void services.snapshots.prune(SNAPSHOT_RETENTION_MS);
  registerIpc(electronIpcHost(ipcMain), services, electronBridge());
  // Shells, the watcher and any agent run would otherwise outlive the window.
  app.on("will-quit", () => services.dispose());

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
