import { useEffect, useMemo, useRef, useState } from "react";
import { filterModelChoices } from "@shared/model-catalog";
import type { ModelChoice, ModelListing } from "@shared/model-catalog";
import type { ProviderId } from "@shared/providers";
import { Icon } from "./Icon";
import { useI18n } from "../i18n/I18nProvider";

interface Props {
  id: string;
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  value: string;
  placeholder?: string;
  /** Display currency and its rate against the catalog currency (0 = show the catalog currency). */
  currency: string;
  exchangeRate: number;
  onChange: (model: string) => void;
}

/** How long typing in the key/URL fields settles before the list is asked again. */
const CREDENTIAL_DEBOUNCE_MS = 600;

/**
 * Searchable model combobox: the provider's known models (priced from the catalog, default marked)
 * plus whatever its live `/v1/models` list adds, tagged "live". Any id can still be typed; a failed
 * listing is shown inline and never blocks typing.
 */
export function ModelPicker({ id, provider, apiKey, baseUrl, value, placeholder, currency, exchangeRate, onChange }: Props) {
  const { t, formatCost, formatRelativeTime } = useI18n();
  const [listing, setListing] = useState<ModelListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const request = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  const load = (refresh: boolean) => {
    const ticket = ++request.current;
    setLoading(true);
    window.archymedes
      .listModels({ provider, apiKey, baseUrl, ...(refresh ? { refresh: true } : {}) })
      .then((result) => {
        if (ticket === request.current) setListing(result);
      })
      .catch((err: unknown) => {
        if (ticket === request.current) {
          setListing({ provider, known: [], live: [], status: "error", error: err instanceof Error ? err.message : String(err) });
        }
      })
      .finally(() => {
        if (ticket === request.current) setLoading(false);
      });
  };

  // A provider switch asks at once; edits to the key or URL wait for typing to settle.
  const lastProvider = useRef<ProviderId | null>(null);
  useEffect(() => {
    const switched = lastProvider.current !== provider;
    lastProvider.current = provider;
    if (switched) {
      setListing(null);
      load(false);
      return;
    }
    const timer = setTimeout(() => load(false), CREDENTIAL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, apiKey, baseUrl]);

  const choices = useMemo<ModelChoice[]>(
    () => (listing && listing.provider === provider ? [...listing.known, ...listing.live] : []),
    [listing, provider],
  );
  const visible = useMemo(() => filterModelChoices(choices, query), [choices, query]);

  useEffect(() => {
    if (active >= 0) listRef.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const pick = (choice: ModelChoice) => {
    onChange(choice.id);
    setOpen(false);
    setActive(-1);
  };

  const price = (choice: ModelChoice): string => {
    if (!choice.price) return t("settings.modelUnpriced");
    const convert = exchangeRate > 0 && currency !== choice.price.currency;
    const shown = convert ? currency : choice.price.currency;
    const scale = convert ? exchangeRate : 1;
    return t("settings.modelPrice", {
      input: formatCost(choice.price.inputPerMillion * scale, shown),
      output: formatCost(choice.price.outputPerMillion * scale, shown),
    });
  };

  const listId = `${id}-list`;
  const status = (() => {
    if (loading && !listing) return t("common.loading");
    if (!listing) return "";
    switch (listing.status) {
      case "no-key":
        return t("settings.modelsNoKey");
      case "unsupported":
        return t("settings.modelsUnsupported");
      case "error":
        return t("settings.modelsError", { error: listing.error ?? "" });
      case "ok":
        return listing.fetchedAt ? t("settings.modelsFetched", { time: formatRelativeTime(listing.fetchedAt) }) : "";
    }
  })();

  return (
    <div className="model-picker">
      <div className="input-group">
        <div className="model-combo">
          <input
            id={id}
            className="input mono"
            dir="ltr"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 && visible[active] ? `${listId}-${active}` : undefined}
            value={value}
            placeholder={placeholder}
            onFocus={() => {
              setQuery("");
              setOpen(true);
            }}
            onClick={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onChange={(e) => {
              onChange(e.target.value);
              setQuery(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
                setActive((i) => Math.min(visible.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                if (open && active >= 0 && visible[active]) {
                  e.preventDefault();
                  pick(visible[active]);
                } else {
                  setOpen(false);
                }
              } else if (e.key === "Escape" && open) {
                // Close the list only; a second Escape still reaches the modal.
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
          {open && visible.length > 0 && (
            <ul className="model-list" id={listId} role="listbox" aria-label={t("settings.modelListLabel")} ref={listRef}>
              {visible.map((choice, index) => (
                <li
                  key={choice.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={choice.id === value}
                  className={`model-option${index === active ? " active" : ""}${choice.id === value ? " selected" : ""}`}
                  // mousedown, not click: it fires before the input's blur closes the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(choice);
                  }}
                  onMouseEnter={() => setActive(index)}
                >
                  <span className="model-option-id" dir="ltr">
                    {choice.id}
                  </span>
                  {choice.isDefault && <span className="model-tag">{t("settings.modelDefault")}</span>}
                  {choice.live && <span className="model-tag live">{t("settings.modelLive")}</span>}
                  <span className={`model-option-price${choice.price ? "" : " unpriced"}`}>{price(choice)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => load(true)}
          disabled={loading || listing?.status === "unsupported" || listing?.status === "no-key"}
          aria-label={t("settings.modelsRefresh")}
          title={t("settings.modelsRefresh")}
        >
          <Icon name="refresh" size={15} />
        </button>
      </div>
      {status && (
        <div className={`field-hint model-status${listing?.status === "error" ? " error" : ""}`} role={listing?.status === "error" ? "alert" : "status"}>
          {loading && listing ? `${t("common.loading")} ` : ""}
          {status}
        </div>
      )}
    </div>
  );
}
