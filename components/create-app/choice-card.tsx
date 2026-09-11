import type { ReactNode } from "react";

export type CreateAppSectionId =
  "app-details" | "build-with" | "store-in" | "deploy-to" | "connections";

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
  return (
    <label
      className={className}
      data-disabled={disabled || undefined}
      data-provider={dataProvider}
    >
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
}

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
        <span role="heading" aria-level={2}>
          {title}
        </span>
      </legend>
      <p>{description}</p>
      {children}
    </fieldset>
  );
}
