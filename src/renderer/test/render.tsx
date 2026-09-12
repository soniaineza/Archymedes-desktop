import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { I18nProvider } from "../src/i18n/I18nProvider";
import { ToastProvider } from "../src/components/Toasts";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>{children}</ToastProvider>
    </I18nProvider>
  );
}

/** Renders with the same providers main.tsx wraps the app in. */
export function renderWithProviders(ui: ReactElement) {
  return render(ui, { wrapper: AppProviders });
}
