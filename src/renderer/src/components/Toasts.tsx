import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { useI18n } from "../i18n/I18nProvider";

type ToastKind = "info" | "success" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

type Notify = (message: string, kind?: ToastKind) => void;

const ToastContext = createContext<Notify>(() => {});

const DISMISS_MS = { info: 3500, success: 2500, error: 7000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback<Notify>(
    (message, kind = "info") => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, kind, message }]);
      setTimeout(() => dismiss(id), DISMISS_MS[kind]);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <Icon name={toast.kind === "error" ? "alert" : toast.kind === "success" ? "check" : "info"} size={15} />
            <span className="toast-text">{toast.message}</span>
            <button className="icon-btn" onClick={() => dismiss(toast.id)} aria-label={t("common.close")}>
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  return useContext(ToastContext);
}
