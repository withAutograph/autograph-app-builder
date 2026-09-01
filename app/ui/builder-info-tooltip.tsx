"use client";

import { Info } from "@geist-ui/icons";
import { useId } from "react";

import styles from "./app-builder.module.css";

export function InfoTooltip({ children }: { children: string }) {
  const tooltipId = useId();

  return (
    <span className={styles.infoTooltip}>
      <button type="button" aria-label={children} aria-describedby={tooltipId}>
        <Info size={12} aria-hidden="true" />
      </button>
      <span id={tooltipId} role="tooltip">
        {children}
      </span>
    </span>
  );
}
