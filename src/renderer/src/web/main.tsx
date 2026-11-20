import React from "react";
import { createRoot } from "react-dom/client";
import type { ArchymedesApi } from "@shared/types";
import { createWebBridge } from "./bridge";
import { WebApp } from "./WebApp";
import "./web.css";

// The web edition installs an in-page backend where Electron's preload would be.
window.archymedes = createWebBridge(window.localStorage) as unknown as ArchymedesApi;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WebApp />
  </React.StrictMode>,
);
