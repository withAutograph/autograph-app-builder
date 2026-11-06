"use client";

import { resolveInputType } from "@better-auth-ui/core";
import type {
  AdditionalField as AdditionalFieldConfig,
  AdditionalFieldValue,
} from "@better-auth-ui/core";
import { useAuth, useCopyToClipboard } from "@better-auth-ui/react";
import { format } from "date-fns";
import { CalendarIcon, Check, ChevronDownIcon, Copy } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { buttonVariants } from "@/components/ui/button-variants";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Field, FieldContent, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface AdditionalFieldProps {
  name: string;
  field: AdditionalFieldConfig;
  isPending?: boolean;
  /** Complete suffix appended to labels for fields that are not required. */
  optionalLabel?: string;
}

/** Convert a `defaultValue` into a `Date` for the calendar. */
const dateValueSchema = z.union([z.date(), z.string()]);
const labelStringSchema = z.string();
const numericDefaultSchema = z
  .union([z.number(), z.string().transform(Number)])
  .refine(Number.isFinite);
const errorMessageSchema = z.object({ message: z.string() });

const toDate = function toDate(value: AdditionalFieldValue | null | undefined): Date | undefined {
  const parsedValue = dateValueSchema.safeParse(value);
  if (!parsedValue.success) {
    return undefined;
  }
  const date = parsedValue.data instanceof Date ? parsedValue.data : new Date(parsedValue.data);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/** Format a Date as `HH:mm:ss` for an `<input type="time">`. */
// Keep this formatter local to the field component.
const formatTime = function formatTime(date: Date) {
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/**
 * Icon-only copy button used as an `InputGroupAddon`. `getValue` is invoked
 * lazily on click so the button copies the input's *live* value rather than a
 * stale snapshot — important when paired with editable inputs.
 */
const CopyButton = function CopyButton({
  getValue,
  isDisabled,
}: {
  getValue: () => string | undefined;
  isDisabled?: boolean;
}) {
  const { localization } = useAuth();
  const { copied, copy } = useCopyToClipboard({
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const handleCopy = async function handleCopy() {
    const value = getValue();
    if (value === undefined || value === "") {
      return;
    }

    await copy(value);
  };

  const onCopyClick = function onCopyClick() {
    const runCopy = async function runCopy() {
      try {
        await handleCopy();
      } catch (error: unknown) {
        const parsedError = errorMessageSchema.safeParse(error);
        toast.error(parsedError.success ? parsedError.data.message : "Unable to copy value.");
      }
    };
    void runCopy();
  };

  return (
    <InputGroupButton
      aria-label={
        copied ? localization.settings.copiedToClipboard : localization.settings.copyToClipboard
      }
      title={
        copied ? localization.settings.copiedToClipboard : localization.settings.copyToClipboard
      }
      onClick={onCopyClick}
      disabled={isDisabled}
    >
      {copied ? <Check /> : <Copy />}
    </InputGroupButton>
  );
};

/** Renders a single additional user field via shadcn primitives. */
const DateInput = function DateInput({ name, field, isPending }: AdditionalFieldProps) {
  const { localization } = useAuth();
  const inputType = resolveInputType(field);
  const isDateTime = inputType === "datetime";

  const [date, setDate] = useState<Date | undefined>(() => toDate(field.defaultValue));
  const [time, setTime] = useState<string>(
    isDateTime && date !== undefined ? formatTime(date) : "",
  );
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();

  // Compose the hidden form value: ISO date for "date", ISO datetime for
  // "datetime" (date + time).
  let formValue = "";
  if (date !== undefined) {
    if (isDateTime && time !== "" && time.trim() !== "") {
      const [h = "0", m = "0", s = "0"] = time.split(":");
      const combined = new Date(date);
      combined.setHours(Number(h), Number(m), Number(s), 0);
      formValue = combined.toISOString();
    } else {
      // Anchor to local midnight then serialize as ISO so the downstream
      // `parseAdditionalFieldValue` parses the same calendar day regardless
      // of timezone (a bare "YYYY-MM-DD" would be parsed as UTC midnight).
      // Datetime fields with a blank time also fall through here, defaulting
      // the time to local midnight since the parsed value is always a `Date`.
      const localMidnight = new Date(date);
      localMidnight.setHours(0, 0, 0, 0);
      formValue = localMidnight.toISOString();
    }
  }

  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor={`${name}-date`}>{field.label}</FieldLabel>

      <div className="relative flex gap-2">
        {/* Visually-hidden input so required constraint validation fires on submit.
            onInvalid suppresses the native browser balloon and routes the message
            through the styled <FieldError> below — matching the pattern used by
            the Name / Email / Password fields in the sign-up form. */}
        <input
          aria-label={labelStringSchema.parse(field.label)}
          type="text"
          name={name}
          value={formValue}
          onChange={() => {
            // This field is display-only in the current authentication flow.
          }}
          required={field.required}
          tabIndex={-1}
          className="sr-only"
          onInvalid={(e) => {
            e.preventDefault();
            setError(e.currentTarget.validationMessage);
          }}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            type="button"
            id={`${name}-date`}
            data-empty={date === undefined}
            aria-invalid={error !== undefined}
            disabled={isPending === true || field.readOnly === true}
            className={cn(
              buttonVariants({ variant: "outline" }),
              "flex-1 justify-between font-normal",
              "data-[empty=true]:text-muted-foreground",
            )}
          >
            {date === undefined ? <span>{field.placeholder}</span> : format(date, "PPP")}

            {isDateTime ? <ChevronDownIcon /> : <CalendarIcon />}
          </PopoverTrigger>

          <PopoverContent className="w-auto overflow-hidden p-0" align="start">
            <Calendar
              mode="single"
              selected={date}
              defaultMonth={date}
              captionLayout="dropdown"
              onSelect={(value) => {
                setDate(value);
                if (value !== undefined) {
                  setError(undefined);
                }
                if (!isDateTime) {
                  setOpen(false);
                }
              }}
            />
          </PopoverContent>
        </Popover>

        {isDateTime && (
          <Field className="w-32">
            <FieldLabel htmlFor={`${name}-time`} className="sr-only">
              {localization.settings.time}
            </FieldLabel>

            <Input
              type="time"
              id={`${name}-time`}
              step="1"
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
              }}
              disabled={isPending === true || field.readOnly === true}
              className="appearance-none bg-background [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
            />
          </Field>
        )}
      </div>

      <FieldError>{error}</FieldError>
    </Field>
  );
};

const SliderField = function SliderField({ name, field, isPending }: AdditionalFieldProps) {
  const maxFractionDigits = field.formatOptions?.maximumFractionDigits;
  const min = field.min ?? 0;
  const max = field.max ?? 100;
  const step = field.step ?? (maxFractionDigits === undefined ? 1 : 1 / 10 ** maxFractionDigits);
  const parsedDefault = numericDefaultSchema.safeParse(field.defaultValue);
  const initial = parsedDefault.success ? parsedDefault.data : min;

  const [value, setValue] = useState<number>(initial);

  const formatter = useMemo(
    () => new Intl.NumberFormat(undefined, field.formatOptions),
    [field.formatOptions],
  );

  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={name}>{field.label}</FieldLabel>
        <span className="text-sm text-muted-foreground tabular-nums">
          {formatter.format(value)}
        </span>
      </div>

      <Slider
        id={name}
        name={name}
        value={[value]}
        onValueChange={(v) => {
          const sliderValuesSchema = z.array(z.number());
          const parsedValues = sliderValuesSchema.safeParse(v);
          setValue(parsedValues.success ? (parsedValues.data[0] ?? min) : min);
        }}
        min={min}
        max={max}
        step={step}
        disabled={isPending === true || field.readOnly === true}
      />

      <FieldError />
    </Field>
  );
};

const InputField = function InputField({ name, field, isPending }: AdditionalFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const hasPrefix = field.prefix !== null && field.prefix !== undefined;
  const hasSuffix =
    (field.suffix !== null && field.suffix !== undefined) || field.copyable === true;

  const isNumeric = field.type === "number";
  const maxFractionDigits = field.formatOptions?.maximumFractionDigits;
  const nativeInputType = isNumeric ? "number" : undefined;
  let nativeInputMode: "decimal" | "numeric" | undefined;
  if (isNumeric) {
    nativeInputMode = maxFractionDigits === undefined ? "numeric" : "decimal";
  }
  const nativeStep = maxFractionDigits === undefined ? undefined : 1 / 10 ** maxFractionDigits;

  if (hasPrefix && hasSuffix) {
    return (
      <Field>
        <FieldLabel htmlFor={name}>{field.label}</FieldLabel>

        <InputGroup>
          <InputGroupAddon align="inline-start">{field.prefix}</InputGroupAddon>

          <InputGroupInput
            ref={inputRef}
            id={name}
            name={name}
            type={nativeInputType}
            inputMode={nativeInputMode}
            step={nativeStep}
            defaultValue={
              field.defaultValue === null || field.defaultValue === undefined
                ? undefined
                : String(field.defaultValue)
            }
            placeholder={field.placeholder}
            required={field.required}
            readOnly={field.readOnly}
            disabled={isPending}
          />

          {field.copyable === true ? (
            <InputGroupAddon align="inline-end">
              <CopyButton getValue={() => inputRef.current?.value} isDisabled={isPending} />
            </InputGroupAddon>
          ) : (
            field.suffix !== null &&
            field.suffix !== undefined && (
              <InputGroupAddon align="inline-end">{field.suffix}</InputGroupAddon>
            )
          )}
        </InputGroup>

        <FieldError />
      </Field>
    );
  }

  return (
    <Field>
      <FieldLabel htmlFor={name}>{field.label}</FieldLabel>

      <Input
        id={name}
        name={name}
        type={nativeInputType}
        inputMode={nativeInputMode}
        step={nativeStep}
        defaultValue={
          field.defaultValue === null || field.defaultValue === undefined
            ? undefined
            : String(field.defaultValue)
        }
        placeholder={field.placeholder}
        required={field.required}
        readOnly={field.readOnly}
        disabled={isPending}
      />

      <FieldError />
    </Field>
  );
};

const scalarDefault = function scalarDefault(value: AdditionalFieldValue | null | undefined) {
  return value === null || value === undefined ? undefined : String(value);
};

const BooleanField = function BooleanField({
  name,
  field,
  isPending,
  inputType,
}: AdditionalFieldProps & { inputType: "switch" | "checkbox" }) {
  const checked = field.defaultValue === true || field.defaultValue === "true";
  const disabled = isPending === true || field.readOnly === true;
  return (
    <Field orientation="horizontal">
      {inputType === "switch" ? (
        <Switch id={name} name={name} defaultChecked={checked} disabled={disabled} />
      ) : (
        <Checkbox
          id={name}
          name={name}
          defaultChecked={checked}
          required={field.required}
          disabled={disabled}
        />
      )}
      <FieldContent>
        <FieldLabel htmlFor={name}>{field.label}</FieldLabel>
      </FieldContent>
    </Field>
  );
};

const NumberField = function NumberField({ name, field, isPending }: AdditionalFieldProps) {
  const digits = field.formatOptions?.maximumFractionDigits;
  const step = field.step ?? (digits === undefined ? undefined : 1 / 10 ** digits);
  return (
    <Field>
      <FieldLabel htmlFor={name}>{field.label}</FieldLabel>
      <Input
        id={name}
        name={name}
        type="number"
        inputMode={digits === undefined ? "numeric" : "decimal"}
        min={field.min}
        max={field.max}
        step={step}
        defaultValue={scalarDefault(field.defaultValue)}
        placeholder={field.placeholder}
        required={field.required}
        readOnly={field.readOnly}
        disabled={isPending}
      />
      <FieldError />
    </Field>
  );
};

const TextareaField = function TextareaField({ name, field, isPending }: AdditionalFieldProps) {
  return (
    <Field>
      <FieldLabel htmlFor={name}>{field.label}</FieldLabel>
      <Textarea
        id={name}
        name={name}
        defaultValue={scalarDefault(field.defaultValue)}
        placeholder={field.placeholder}
        required={field.required}
        readOnly={field.readOnly}
        disabled={isPending}
      />
      <FieldError />
    </Field>
  );
};

const SelectField = function SelectField({ name, field, isPending }: AdditionalFieldProps) {
  return (
    <Field>
      <FieldLabel htmlFor={name}>{field.label}</FieldLabel>
      <Select
        name={name}
        defaultValue={scalarDefault(field.defaultValue)}
        required={field.required}
        disabled={isPending === true || field.readOnly === true}
      >
        <SelectTrigger id={name} className="w-full">
          <SelectValue placeholder={field.placeholder} />
        </SelectTrigger>
        <SelectContent>
          {field.options?.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError />
    </Field>
  );
};

const ComboboxField = function ComboboxField({ name, field, isPending }: AdditionalFieldProps) {
  return (
    <Field>
      <FieldLabel htmlFor={name}>{field.label}</FieldLabel>
      <Combobox
        items={field.options ?? []}
        name={name}
        defaultValue={scalarDefault(field.defaultValue)}
        required={field.required}
        disabled={isPending === true || field.readOnly === true}
      >
        <ComboboxInput placeholder={field.placeholder} id={name} />
        <ComboboxContent>
          <ComboboxEmpty>No items found.</ComboboxEmpty>
          <ComboboxList>
            {(
              option: AdditionalFieldConfig["options"] extends (infer Option)[] | undefined
                ? Option
                : never,
            ) => (
              <ComboboxItem key={option.value} value={option}>
                {option.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <FieldError />
    </Field>
  );
};

export const AdditionalField = function AdditionalField({
  name,
  field: configuredField,
  isPending,
  optionalLabel,
}: AdditionalFieldProps) {
  const field =
    optionalLabel !== undefined && configuredField.required !== true
      ? {
          ...configuredField,
          label: (
            <>
              {configuredField.label}
              {optionalLabel}
            </>
          ),
        }
      : configuredField;
  const inputType = resolveInputType(field);

  if (field.render !== undefined) {
    const FieldRenderer = field.render;
    return <FieldRenderer name={name} field={field} isPending={isPending} />;
  }

  switch (inputType) {
    case "textarea": {
      return <TextareaField name={name} field={field} isPending={isPending} />;
    }
    case "number": {
      return <NumberField name={name} field={field} isPending={isPending} />;
    }
    case "slider": {
      return <SliderField name={name} field={field} isPending={isPending} />;
    }
    case "switch":
    case "checkbox": {
      return <BooleanField name={name} field={field} isPending={isPending} inputType={inputType} />;
    }
    case "select": {
      return <SelectField name={name} field={field} isPending={isPending} />;
    }
    case "combobox": {
      return <ComboboxField name={name} field={field} isPending={isPending} />;
    }
    case "date":
    case "datetime": {
      return <DateInput name={name} field={field} isPending={isPending} />;
    }
    case "input": {
      return <InputField name={name} field={field} isPending={isPending} />;
    }
    case "hidden": {
      return <input type="hidden" name={name} value={scalarDefault(field.defaultValue) ?? ""} />;
    }
    default: {
      return <InputField name={name} field={field} isPending={isPending} />;
    }
  }
};

/**
 * Slider field. Radix Slider doesn't render the current value, so we render
 * it next to the label and control the state to keep the displayed value in
 * sync. The selected value is submitted via the underlying Radix `name` prop.
 */

/**
 * Date / datetime input. Composes `Popover` + `Calendar` for the date and
 * (optionally) `<input type="time">` for the time. Submits the combined ISO
 * value via a hidden `<input>` so it shows up in `FormData`.
 */
