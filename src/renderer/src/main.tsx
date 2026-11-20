import React from "react";
import { createRoot } from "react-dom/client";
import { Root } from "./Root";
import { I18nProvider } from "./i18n/I18nProvider";
import { ToastProvider } from "./components/Toasts";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <I18nProvider>
      <ToastProvider>
        <Root />
      </ToastProvider>
    </I18nProvider>
  </React.StrictMode>,
);
