"use client";

import { Search } from "@geist-ui/icons";
import { InfoTooltip } from "./builder-info-tooltip";
import { SearchCombobox, type ComboOption } from "./search-combobox";
import styles from "./app-builder.module.css";

export function ModelControls({
  available,
  model,
  onModelChange,
  onRetry,
  onZdrChange,
  options,
  zdrOnly,
}: {
  available: boolean;
  model: string;
  onModelChange: (value: string) => void;
  onRetry: () => void;
  onZdrChange: (value: boolean) => void;
  options: ComboOption[];
  zdrOnly: boolean;
}) {
  return (
    <fieldset className={styles.modelField}>
      <legend>Model</legend>
      <label className={styles.checkLine}>
        <input
          type="checkbox"
          name="zdr"
          checked={zdrOnly}
          onChange={(event) => onZdrChange(event.target.checked)}
        />{" "}
        Zero Data Retention
        <InfoTooltip>Only use providers that support Zero Data Retention.</InfoTooltip>
      </label>
      <SearchCombobox
        label={options.find((option) => option.value === model)?.label ?? "Select model"}
        value={model}
        options={options}
        onChange={onModelChange}
        placeholder={available ? "Select model" : "Models unavailable"}
        disabled={!available}
        prefix={<Search size={15} />}
        showSelectedCheck={false}
      />
      {available ? null : (
        <button className={styles.retryModels} type="button" onClick={onRetry}>
          Retry models
        </button>
      )}
    </fieldset>
  );
}
