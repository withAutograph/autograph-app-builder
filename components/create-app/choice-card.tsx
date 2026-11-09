import type { ReactNode } from "react";

export type CreateAppSectionId =
  | "app-details"
  | "build-with"
  | "store-in"
  | "deploy-to"
  | "connections";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function ChoiceCard({
  badge,
  checked,
  children,
  className,
  dataProvider,
  disabled = false,
  icon,
  inputType = "checkbox",
  name,
  onChange,
  value,
}: {
  badge?: string;
  checked: boolean;
  children: ReactNode;
  className?: string;
  dataProvider?: string;
  disabled?: boolean;
  icon?: ReactNode;
  inputType?: "checkbox" | "radio";
  name: string;
  onChange: () => void;
  value: string;
}) {
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  return (
    <label className={className} data-disabled={disabled || undefined} data-provider={dataProvider}>
      {icon}
      <span>
        {children}
        {badge ? <small>{badge}</small> : null}
      </span>
      <input
        type={inputType}
        name={name}
        value={value}
        disabled={disabled}
        checked={checked}
        onChange={onChange}
      />
    </label>
  );
  /* oxlint-enable typescript/strict-boolean-expressions */
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function SectionShell({
  children,
  className,
  description,
  section,
  title,
}: {
  children: ReactNode;
  className?: string;
  description: string;
  section: CreateAppSectionId;
  title: string;
}) {
  return (
    <fieldset className={className} data-create-app-section={section}>
      <legend>
        <h2>{title}</h2>
      </legend>
      <p>{description}</p>
      {children}
    </fieldset>
  );
}
