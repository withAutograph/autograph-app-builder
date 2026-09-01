"use client";

import { Check, ChevronDown, Plus } from "@geist-ui/icons";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import styles from "./app-builder.module.css";

export type ComboOption = {
  value: string;
  label: string;
  detail?: string;
  icon?: string;
};

type ComboFooter = ComboOption & { disabled?: boolean };

type SearchComboboxProps = {
  label: string;
  value: string;
  options: ComboOption[];
  onChange: (value: string) => void;
  input?: {
    id?: string;
    placeholder?: string;
    disabled?: boolean;
  };
  presentation: {
    prefix: ReactNode;
    footerIcon?: ReactNode;
    detailPills?: boolean;
    showSelectedCheck?: boolean;
    optionIcon?: (option: ComboOption) => ReactNode;
  };
  footer?: {
    option: ComboFooter;
    onSelect?: () => void;
  };
};

function useComboboxController({
  value,
  options,
  onChange,
}: Pick<SearchComboboxProps, "value" | "options" | "onChange">) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const [query, setQuery] = useState(selected?.label ?? "");
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(0);
  const shown = filtering
    ? options.filter((option) =>
        `${option.label} ${option.detail ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
    : options;

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  function closeAndRestore() {
    setOpen(false);
    setQuery(selected?.label ?? "");
    setFiltering(false);
    setActive(0);
  }

  function choose(option: ComboOption) {
    if (option.value.startsWith("create-") || option.value.startsWith("add-"))
      return;
    onChange(option.value);
    setQuery(option.label);
    setFiltering(false);
    setOpen(false);
  }

  function onInputFocus(event: FocusEvent<HTMLInputElement>) {
    setOpen(true);
    setFiltering(false);
    event.currentTarget.select();
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    setQuery(event.target.value);
    setFiltering(true);
    setOpen(true);
    setActive(0);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") closeAndRestore();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, Math.max(shown.length - 1, 0)));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    }
    if (event.key === "Enter" && open && shown[active]) {
      event.preventDefault();
      choose(shown[active]);
    }
  }

  return {
    id,
    rootRef,
    selected,
    isOpen: open,
    input: {
      query,
      onFocus: onInputFocus,
      onChange: onInputChange,
      onKeyDown: onInputKeyDown,
    },
    menu: {
      active,
      options: shown,
      onChoose: choose,
      onOptionFocus: setActive,
    },
    toggle: () => setOpen((current) => !current),
    close: () => setOpen(false),
  };
}

type ComboboxInputProps = {
  disabled: boolean;
  id: string;
  inputId?: string;
  label: string;
  placeholder: string;
  controller: ReturnType<typeof useComboboxController>["input"];
};

function ComboboxInput({
  disabled,
  id,
  inputId,
  label,
  placeholder,
  controller,
}: ComboboxInputProps) {
  return (
    <input
      id={inputId}
      role="searchbox"
      aria-label={label}
      aria-autocomplete="list"
      aria-controls={`${id}-listbox`}
      value={controller.query}
      placeholder={placeholder}
      disabled={disabled}
      autoComplete="off"
      spellCheck={false}
      onFocus={controller.onFocus}
      onChange={controller.onChange}
      onKeyDown={controller.onKeyDown}
    />
  );
}

function ComboboxOptions({
  controller,
  presentation,
  value,
}: Pick<SearchComboboxProps, "presentation" | "value"> & {
  controller: ReturnType<typeof useComboboxController>["menu"];
}) {
  const {
    detailPills = false,
    optionIcon,
    showSelectedCheck = true,
  } = presentation;
  return (
    <>
      {controller.options.map((option, index) => (
        <button
          type="button"
          role="option"
          aria-selected={option.value === value}
          data-has-icon={optionIcon ? "" : undefined}
          data-option-value={option.value}
          data-active={index === controller.active || undefined}
          key={option.value}
          onPointerMove={() => controller.onOptionFocus(index)}
          onClick={() => controller.onChoose(option)}
        >
          {optionIcon ? (
            <span className={styles.comboOptionIcon} aria-hidden="true">
              {optionIcon(option)}
            </span>
          ) : null}
          <span className={styles.comboOptionLabel}>{option.label}</span>
          {option.detail ? (
            <small data-pill={detailPills || undefined}>{option.detail}</small>
          ) : null}
          {showSelectedCheck && option.value === value ? (
            <Check size={16} aria-hidden="true" />
          ) : null}
        </button>
      ))}
      {!controller.options.length ? (
        <p className={styles.noResults}>No results found.</p>
      ) : null}
    </>
  );
}

function ComboboxFooter({
  footer,
  presentation,
  onSelect,
}: Pick<SearchComboboxProps, "footer" | "presentation"> & {
  onSelect?: () => void;
}) {
  if (!footer) return null;
  return (
    <button
      className={styles.comboFooter}
      type="button"
      disabled={footer.option.disabled}
      onClick={onSelect}
    >
      <span className={styles.comboOptionIcon} aria-hidden="true">
        {presentation.footerIcon ?? <Plus size={20} />}
      </span>
      <span className={styles.comboOptionLabel}>{footer.option.label}</span>
    </button>
  );
}

export function SearchCombobox(props: SearchComboboxProps) {
  const { input = {}, label, presentation, footer, value } = props;
  const controller = useComboboxController(props);
  const { disabled = false, id: inputId, placeholder = "Select…" } = input;

  return (
    <div
      className={styles.combobox}
      ref={controller.rootRef}
      data-open={controller.isOpen || undefined}
      data-label={label}
      role="combobox"
      aria-expanded={controller.isOpen}
      aria-haspopup="listbox"
      aria-controls={`${controller.id}-listbox`}
    >
      <div className={styles.comboPrefix} aria-hidden="true">
        {presentation.prefix}
      </div>
      <ComboboxInput
        disabled={disabled}
        id={controller.id}
        inputId={inputId}
        label={label}
        placeholder={placeholder}
        controller={controller.input}
      />
      {controller.selected?.detail ? (
        <span className={styles.comboDetail}>{controller.selected.detail}</span>
      ) : null}
      <button
        type="button"
        aria-label={controller.isOpen ? "Close menu" : "Open menu"}
        onClick={controller.toggle}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div
        className={styles.comboMenu}
        role="dialog"
        hidden={!controller.isOpen}
      >
        <div id={`${controller.id}-listbox`} role="listbox">
          <ComboboxOptions
            controller={controller.menu}
            presentation={presentation}
            value={value}
          />
        </div>
        <ComboboxFooter
          footer={footer}
          presentation={presentation}
          onSelect={() => {
            controller.close();
            footer?.onSelect?.();
          }}
        />
      </div>
    </div>
  );
}
