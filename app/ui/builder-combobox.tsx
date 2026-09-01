"use client";

import { Check, ChevronDown, Plus } from "@geist-ui/icons";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

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
  prefix: ReactNode;
  menuFooter?: ComboFooter;
  optionIcon?: (option: ComboOption) => ReactNode;
  footerIcon?: ReactNode;
  detailPills?: boolean;
  showSelectedCheck?: boolean;
  placeholder?: string;
  disabled?: boolean;
  onFooterSelect?: () => void;
  inputId?: string;
};

function useComboboxController({
  value,
  options,
  onChange,
}: SearchComboboxProps) {
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

  return {
    active,
    choose,
    closeAndRestore,
    id,
    open,
    query,
    rootRef,
    selected,
    setActive,
    setFiltering,
    setOpen,
    setQuery,
    shown,
  };
}

type ComboboxInputProps = {
  active: number;
  disabled: boolean;
  id: string;
  inputId?: string;
  label: string;
  onChoose: (option: ComboOption) => void;
  onCloseAndRestore: () => void;
  open: boolean;
  placeholder: string;
  query: string;
  setActive: (active: number | ((current: number) => number)) => void;
  setFiltering: (filtering: boolean) => void;
  setOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  setQuery: (query: string) => void;
  shown: ComboOption[];
};

function ComboboxInput({
  active,
  disabled,
  id,
  inputId,
  label,
  onChoose,
  onCloseAndRestore,
  open,
  placeholder,
  query,
  setActive,
  setFiltering,
  setOpen,
  setQuery,
  shown,
}: ComboboxInputProps) {
  return (
    <input
      id={inputId}
      role="searchbox"
      aria-label={label}
      aria-autocomplete="list"
      aria-controls={`${id}-listbox`}
      value={query}
      placeholder={placeholder}
      disabled={disabled}
      autoComplete="off"
      spellCheck={false}
      onFocus={(event) => {
        setOpen(true);
        setFiltering(false);
        event.currentTarget.select();
      }}
      onChange={(event) => {
        setQuery(event.target.value);
        setFiltering(true);
        setOpen(true);
        setActive(0);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCloseAndRestore();
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setOpen(true);
          setActive((index) =>
            Math.min(index + 1, Math.max(shown.length - 1, 0)),
          );
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive((index) => Math.max(index - 1, 0));
        }
        if (event.key === "Enter" && open && shown[active]) {
          event.preventDefault();
          onChoose(shown[active]);
        }
      }}
    />
  );
}

function ComboboxOptions({
  active,
  detailPills,
  onChoose,
  optionIcon,
  setActive,
  showSelectedCheck,
  shown,
  value,
}: Pick<
  SearchComboboxProps,
  "detailPills" | "optionIcon" | "showSelectedCheck" | "value"
> & {
  active: number;
  onChoose: (option: ComboOption) => void;
  setActive: (active: number) => void;
  shown: ComboOption[];
}) {
  return (
    <>
      {shown.map((option, index) => (
        <button
          type="button"
          role="option"
          aria-selected={option.value === value}
          data-has-icon={optionIcon ? "" : undefined}
          data-option-value={option.value}
          data-active={index === active || undefined}
          key={option.value}
          onPointerMove={() => setActive(index)}
          onClick={() => onChoose(option)}
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
      {!shown.length ? (
        <p className={styles.noResults}>No results found.</p>
      ) : null}
    </>
  );
}

function ComboboxFooter({
  menuFooter,
  footerIcon,
  onSelect,
}: Pick<SearchComboboxProps, "menuFooter" | "footerIcon"> & {
  onSelect?: () => void;
}) {
  if (!menuFooter) return null;
  return (
    <button
      className={styles.comboFooter}
      type="button"
      disabled={menuFooter.disabled}
      onClick={onSelect}
    >
      <span className={styles.comboOptionIcon} aria-hidden="true">
        {footerIcon ?? <Plus size={20} />}
      </span>
      <span className={styles.comboOptionLabel}>{menuFooter.label}</span>
    </button>
  );
}

export function SearchCombobox(props: SearchComboboxProps) {
  const controller = useComboboxController(props);
  const {
    label,
    prefix,
    menuFooter,
    footerIcon,
    detailPills = false,
    showSelectedCheck = true,
    placeholder = "Select…",
    disabled = false,
    inputId,
    optionIcon,
    value,
    onFooterSelect,
  } = props;
  const {
    active,
    choose,
    closeAndRestore,
    id,
    open,
    query,
    rootRef,
    selected,
    setActive,
    setFiltering,
    setOpen,
    setQuery,
    shown,
  } = controller;

  return (
    <div
      className={styles.combobox}
      ref={rootRef}
      data-open={open || undefined}
      data-label={label}
      role="combobox"
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-controls={`${id}-listbox`}
    >
      <div className={styles.comboPrefix} aria-hidden="true">
        {prefix}
      </div>
      <ComboboxInput
        active={active}
        disabled={disabled}
        id={id}
        inputId={inputId}
        label={label}
        onChoose={choose}
        onCloseAndRestore={closeAndRestore}
        open={open}
        placeholder={placeholder}
        query={query}
        setActive={setActive}
        setFiltering={setFiltering}
        setOpen={setOpen}
        setQuery={setQuery}
        shown={shown}
      />
      {selected?.detail ? (
        <span className={styles.comboDetail}>{selected.detail}</span>
      ) : null}
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div className={styles.comboMenu} role="dialog" hidden={!open}>
        <div id={`${id}-listbox`} role="listbox">
          <ComboboxOptions
            active={active}
            detailPills={detailPills}
            onChoose={choose}
            optionIcon={optionIcon}
            setActive={setActive}
            showSelectedCheck={showSelectedCheck}
            shown={shown}
            value={value}
          />
        </div>
        <ComboboxFooter
          menuFooter={menuFooter}
          footerIcon={footerIcon}
          onSelect={() => {
            setOpen(false);
            onFooterSelect?.();
          }}
        />
      </div>
    </div>
  );
}
