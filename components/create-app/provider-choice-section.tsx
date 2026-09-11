import type { ComponentType, ReactNode } from "react";

import {
  ChoiceCard,
  SectionShell,
  type CreateAppSectionId,
} from "./choice-card";

export type ProviderChoice<Provider extends string> = {
  available: boolean;
  icon: ComponentType<{
    "aria-hidden"?: boolean | "true" | "false";
    size?: number | string;
  }>;
  name: string;
  provider: Provider;
};

export function ProviderChoiceSection<Provider extends string>({
  children,
  className,
  description,
  gridClassName,
  label,
  name,
  onChange,
  options,
  selected,
  section,
  title,
  unavailableClassName,
}: {
  children?: ReactNode;
  className?: string;
  description: string;
  gridClassName?: string;
  label: string;
  name: string;
  onChange: (provider: Provider) => void;
  options: readonly ProviderChoice<Provider>[];
  selected: Provider | null;
  section: CreateAppSectionId;
  title: string;
  unavailableClassName?: string;
}) {
  return (
    <SectionShell
      className={className}
      section={section}
      title={title}
      description={description}
    >
      <div className={gridClassName} role="group" aria-label={label}>
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <ChoiceCard
              key={option.provider}
              dataProvider={option.provider}
              className={!option.available ? unavailableClassName : undefined}
              disabled={!option.available}
              checked={option.available && selected === option.provider}
              name={name}
              value={option.provider}
              badge={!option.available ? "Coming soon" : undefined}
              icon={<Icon size={18} aria-hidden="true" />}
              onChange={() => onChange(option.provider)}
            >
              {option.name}
            </ChoiceCard>
          );
        })}
      </div>
      {children}
    </SectionShell>
  );
}
