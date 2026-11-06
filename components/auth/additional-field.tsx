"use client";

import { resolveInputType } from "@better-auth-ui/core";
import type {
  AdditionalField as AdditionalFieldConfig,
  AdditionalFieldRenderProps,
} from "@better-auth-ui/core";
import { useAuth, useCopyToClipboard } from "@better-auth-ui/react";
import { format } from "date-fns";
import { CalendarIcon, Check, ChevronDownIcon, Copy } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { buttonVariants } from "@/components/ui/button";
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

/** Convert a parsed field default into a `Date` for the calendar. */
type DateDefaultValue = string | Date | number | boolean | null | undefined;

const parseDateInput = (value: DateDefaultValue): Date | undefined => {
  if (value instanceof Date) {
    return value;
  }
  const input = String(value ?? "");
  if (input === "") {
    return undefined;
  }
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const toDate = function toDate(value: DateDefaultValue): Date | undefined {
  return parseDateInput(value);
};

/** Format a Date as `HH:mm:ss` for an `<input type="time">`. */
// Keep this formatter local to the field component.
const formatTime = function formatTime(date: Date) {
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const noop = () => {
  // Custom fields are display-only in this form renderer.
};

type SliderValue = number | readonly number[] | undefined;

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

  const handleCopy = async function handleCopy(): Promise<void> {
    const value = getValue();
    if (value === undefined || value === "") {
      return;
    }

    await copy(value);
  };

  return (
    <InputGroupButton
      aria-label={
        copied ? localization.settings.copiedToClipboard : localization.settings.copyToClipboard
      }
      title={
        copied ? localization.settings.copiedToClipboard : localization.settings.copyToClipboard
      }
      onClick={() => {
        void handleCopy();
      }}
      disabled={isDisabled}
    >
      {copied ? <Check /> : <Copy />}
    </InputGroupButton>
  );
};

/** Renders a single additional user field via shadcn primitives. */
const DateInput = function DateInput({ name, field, isPending }: AdditionalFieldProps) {
  const { localization } = useAuth();
  const isDateTime = resolveInputType(field) === "datetime";

  const [date, setDate] = useState<Date | undefined>(() => toDate(field.defaultValue));
  const [time, setTime] = useState<string>(isDateTime && date ? formatTime(date) : "");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const hasError = error !== undefined && error !== "";

  // Compose the hidden form value: ISO date for "date", ISO datetime for
  // "datetime" (date + time).
  let formValue = "";
  if (date) {
    if (isDateTime && time && time.trim() !== "") {
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
    <Field data-invalid={hasError}>
      <FieldLabel htmlFor={`${name}-date`}>{field.label}</FieldLabel>

      <div className="relative flex gap-2">
        {/* Visually-hidden input so required constraint validation fires on submit.
            onInvalid suppresses the native browser balloon and routes the message
            through the styled <FieldError> below — matching the pattern used by
            the Name / Email / Password fields in the sign-up form. */}
        <input
          aria-label={name}
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
            aria-invalid={hasError}
            disabled={isPending === true || field.readOnly === true}
            className={cn(
              buttonVariants({ variant: "outline" }),
              "flex-1 justify-between font-normal",
              "data-[empty=true]:text-muted-foreground",
            )}
          >
            {date ? format(date, "PPP") : <span>{field.placeholder}</span>}

            {isDateTime ? <ChevronDownIcon /> : <CalendarIcon />}
          </PopoverTrigger>

          <PopoverContent className="w-auto overflow-hidden p-0" align="start">
            <Calendar
              mode="single"
              selected={date}
              defaultMonth={date}
              captionLayout="dropdown"
              onSelect={(value: Date | undefined) => {
                setDate(value);
                if (value) {
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
  const step =
    field.step ??
    (maxFractionDigits !== null && maxFractionDigits !== undefined
      ? 1 / 10 ** maxFractionDigits
      : 1);
  let initial = min;
  const parsedDefault = Number(field.defaultValue);
  if (
    field.defaultValue !== null &&
    field.defaultValue !== undefined &&
    !Number.isNaN(parsedDefault)
  ) {
    initial = parsedDefault;
  }

  const [value, setValue] = useState<number>(initial);

  const formatter = useMemo(
    () => new Intl.NumberFormat(undefined, field.formatOptions),
    [field.formatOptions],
  );
  const formattedValue = formatter.format(value);

  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={name}>{field.label}</FieldLabel>
        <span className="text-sm text-muted-foreground tabular-nums">{formattedValue}</span>
      </div>

      <Slider
        id={name}
        name={name}
        value={[value]}
        onValueChange={(sliderValue: SliderValue) => {
          const nextValue = Array.isArray(sliderValue) ? sliderValue[0] : sliderValue;
          setValue(nextValue ?? min);
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
    nativeInputMode =
      maxFractionDigits !== null && maxFractionDigits !== undefined ? "decimal" : "numeric";
  }
  const nativeStep =
    maxFractionDigits !== null && maxFractionDigits !== undefined
      ? 1 / 10 ** maxFractionDigits
      : undefined;

  if (hasPrefix || hasSuffix) {
    return (
      <Field>
        <FieldLabel htmlFor={name}>{field.label}</FieldLabel>

        <InputGroup>
          {hasPrefix && <InputGroupAddon align="inline-start">{field.prefix}</InputGroupAddon>}

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

const renderDateField = (name: string, field: AdditionalFieldConfig, isPending = false) => (
  <DateInput name={name} field={field} isPending={isPending} />
);

const renderSliderField = (name: string, field: AdditionalFieldConfig, isPending = false) => (
  <SliderField name={name} field={field} isPending={isPending} />
);

const renderField = function renderField({
  name,
  field: configuredField,
  isPending,
  optionalLabel,
}: AdditionalFieldProps) {
  const field =
    optionalLabel !== undefined && optionalLabel !== "" && configuredField.required !== true
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
    const renderProps: AdditionalFieldRenderProps = {
      field,
      isPending,
      name,
      onBlur: noop,
      onChange: noop,
      value: field.defaultValue ?? null,
    };
    return field.render(renderProps);
  }

  if (inputType === "hidden") {
    let hiddenValue = "";
    if (field.defaultValue !== null && field.defaultValue !== undefined) {
      hiddenValue =
        field.defaultValue instanceof Date
          ? field.defaultValue.toISOString()
          : String(field.defaultValue);
    }

    return <input type="hidden" name={name} value={hiddenValue} />;
  }

  if (inputType === "textarea") {
    return (
      <Field>
        <FieldLabel htmlFor={name}>{field.label}</FieldLabel>

        <Textarea
          id={name}
          name={name}
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
  }

  if (inputType === "number") {
    const maxFractionDigits = field.formatOptions?.maximumFractionDigits;
    let defaultValue: number | string | undefined;
    if (field.defaultValue !== null && field.defaultValue !== undefined) {
      const parsed = Number(field.defaultValue);
      defaultValue = Number.isNaN(parsed) ? String(field.defaultValue) : parsed;
    }

    return (
      <Field>
        <FieldLabel htmlFor={name}>{field.label}</FieldLabel>

        <Input
          id={name}
          name={name}
          type="number"
          inputMode={
            maxFractionDigits !== null && maxFractionDigits !== undefined ? "decimal" : "numeric"
          }
          min={field.min}
          max={field.max}
          step={
            field.step ??
            (maxFractionDigits !== null && maxFractionDigits !== undefined
              ? 1 / 10 ** maxFractionDigits
              : undefined)
          }
          defaultValue={defaultValue}
          placeholder={field.placeholder}
          required={field.required}
          readOnly={field.readOnly}
          disabled={isPending}
        />

        <FieldError />
      </Field>
    );
  }

  if (inputType === "slider") {
    return renderSliderField(name, field, isPending);
  }

  if (inputType === "switch") {
    return (
      <Field orientation="horizontal">
        <Switch
          id={name}
          name={name}
          defaultChecked={field.defaultValue === true || field.defaultValue === "true"}
          disabled={isPending === true || field.readOnly === true}
        />

        <FieldContent>
          <FieldLabel htmlFor={name}>{field.label}</FieldLabel>
        </FieldContent>
      </Field>
    );
  }

  if (inputType === "checkbox") {
    return (
      <Field orientation="horizontal">
        <Checkbox
          id={name}
          name={name}
          defaultChecked={field.defaultValue === true || field.defaultValue === "true"}
          required={field.required}
          disabled={isPending === true || field.readOnly === true}
        />

        <FieldContent>
          <FieldLabel htmlFor={name}>{field.label}</FieldLabel>
        </FieldContent>
      </Field>
    );
  }

  if (inputType === "select") {
    return (
      <Field>
        <FieldLabel htmlFor={name}>{field.label}</FieldLabel>

        <Select
          name={name}
          defaultValue={
            field.defaultValue === null || field.defaultValue === undefined
              ? undefined
              : String(field.defaultValue)
          }
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
  }

  if (inputType === "combobox") {
    return (
      <Field>
        <FieldLabel htmlFor={name}>{field.label}</FieldLabel>

        <Combobox
          items={field.options ?? []}
          name={name}
          defaultValue={
            field.defaultValue === null || field.defaultValue === undefined
              ? undefined
              : String(field.defaultValue)
          }
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
  }

  if (inputType === "date" || inputType === "datetime") {
    return renderDateField(name, field, isPending);
  }

  return <InputField name={name} field={field} isPending={isPending} />;
};

export const AdditionalField = renderField;

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
