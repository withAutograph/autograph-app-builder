"use client";

import { useEffect, useRef } from "react";
import type { ComponentProps } from "react";
import { DayPicker } from "react-day-picker";
import type { ClassNames, DayButton, Locale } from "react-day-picker";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon, ChevronDownIcon } from "lucide-react";

const defaultClassNames: ClassNames = {
  button_next: "rdp-button_next",
  button_previous: "rdp-button_previous",
  caption_after_enter: "rdp-caption_after_enter",
  caption_after_exit: "rdp-caption_after_exit",
  caption_before_enter: "rdp-caption_before_enter",
  caption_before_exit: "rdp-caption_before_exit",
  caption_label: "rdp-caption_label",
  chevron: "rdp-chevron",
  day: "rdp-day",
  day_button: "rdp-day_button",
  disabled: "rdp-disabled",
  dropdown: "rdp-dropdown",
  dropdown_root: "rdp-dropdown_root",
  dropdowns: "rdp-dropdowns",
  focused: "rdp-focused",
  footer: "rdp-footer",
  hidden: "rdp-hidden",
  month: "rdp-month",
  month_caption: "rdp-month_caption",
  month_grid: "rdp-month_grid",
  months: "rdp-months",
  months_dropdown: "rdp-months_dropdown",
  nav: "rdp-nav",
  outside: "rdp-outside",
  range_end: "rdp-range_end",
  range_middle: "rdp-range_middle",
  range_start: "rdp-range_start",
  root: "rdp-root",
  selected: "rdp-selected",
  today: "rdp-today",
  week: "rdp-week",
  week_number: "rdp-week_number",
  week_number_header: "rdp-week_number_header",
  weekday: "rdp-weekday",
  weekdays: "rdp-weekdays",
  weeks: "rdp-weeks",
  weeks_after_enter: "rdp-weeks_after_enter",
  weeks_after_exit: "rdp-weeks_after_exit",
  weeks_before_enter: "rdp-weeks_before_enter",
  weeks_before_exit: "rdp-weeks_before_exit",
  years_dropdown: "rdp-years_dropdown",
};

const getNavButtonVariantClass = (variant: ComponentProps<typeof Button>["variant"]): string => {
  switch (variant) {
    case "default": {
      return "bg-primary text-primary-foreground hover:bg-primary/80";
    }
    case "destructive": {
      return "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40";
    }
    case "ghost": {
      return "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50";
    }
    case "link": {
      return "text-primary underline-offset-4 hover:underline";
    }
    case "outline": {
      return "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50";
    }
    case "secondary": {
      return "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground";
    }
  }
};

const CalendarDayButton = ({
  className: dayClassName,
  day,
  modifiers,
  locale,
  ...props
}: ComponentProps<typeof DayButton> & { locale?: Partial<Locale> }) => {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (modifiers.focused) {
      ref.current?.focus();
    }
  }, [modifiers.focused]);

  return (
    <Button
      variant="ghost"
      size="icon"
      data-day={day.date.toLocaleDateString(locale?.code)}
      data-selected-single={
        modifiers.selected &&
        !modifiers.range_start &&
        !modifiers.range_end &&
        !modifiers.range_middle
      }
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        "relative isolate z-10 flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 border-0 leading-none font-normal group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-[3px] group-data-[focused=true]/day:ring-ring/50 data-[range-end=true]:rounded-(--cell-radius) data-[range-end=true]:rounded-r-(--cell-radius) data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-muted data-[range-middle=true]:text-foreground data-[range-start=true]:rounded-(--cell-radius) data-[range-start=true]:rounded-l-(--cell-radius) data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground dark:hover:text-foreground [&>span]:text-xs [&>span]:opacity-70",
        defaultClassNames.day,
        dayClassName,
      )}
      {...props}
    />
  );
};

const Calendar = ({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = "label",
  buttonVariant = "ghost",
  locale,
  formatters,
  components,
  ...props
}: ComponentProps<typeof DayPicker> & {
  buttonVariant?: ComponentProps<typeof Button>["variant"];
}) => {
  const navButtonVariantClass = getNavButtonVariantClass(buttonVariant);

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(
        "group/calendar bg-background p-2 [--cell-radius:var(--radius-md)] [--cell-size:--spacing(7)] in-data-[slot=card-content]:bg-transparent in-data-[slot=popover-content]:bg-transparent",
        String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
        String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
        className,
      )}
      captionLayout={captionLayout}
      locale={locale}
      formatters={{
        formatMonthDropdown: (date) => date.toLocaleString(locale?.code, { month: "short" }),
        ...formatters,
      }}
      classNames={{
        button_next: cn(
          navButtonVariantClass,
          "size-(--cell-size) p-0 select-none aria-disabled:opacity-50",
          defaultClassNames.button_next,
        ),
        button_previous: cn(
          navButtonVariantClass,
          "size-(--cell-size) p-0 select-none aria-disabled:opacity-50",
          defaultClassNames.button_previous,
        ),
        caption_label: cn(
          "font-medium select-none",
          captionLayout === "label"
            ? "text-sm"
            : "flex items-center gap-1 rounded-(--cell-radius) text-sm [&>svg]:size-3.5 [&>svg]:text-muted-foreground",
          defaultClassNames.caption_label,
        ),
        day: cn(
          "group/day relative aspect-square h-full w-full rounded-(--cell-radius) p-0 text-center select-none [&:last-child[data-selected=true]_button]:rounded-r-(--cell-radius)",
          props.showWeekNumber === true
            ? "[&:nth-child(2)[data-selected=true]_button]:rounded-l-(--cell-radius)"
            : "[&:first-child[data-selected=true]_button]:rounded-l-(--cell-radius)",
          defaultClassNames.day,
        ),
        disabled: cn("text-muted-foreground opacity-50", defaultClassNames.disabled),
        dropdown: cn("absolute inset-0 bg-popover opacity-0", defaultClassNames.dropdown),
        dropdown_root: cn("relative rounded-(--cell-radius)", defaultClassNames.dropdown_root),
        dropdowns: cn(
          "flex h-(--cell-size) w-full items-center justify-center gap-1.5 text-sm font-medium",
          defaultClassNames.dropdowns,
        ),
        hidden: cn("invisible", defaultClassNames.hidden),
        month: cn("flex w-full flex-col gap-4", defaultClassNames.month),
        month_caption: cn(
          "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
          defaultClassNames.month_caption,
        ),
        month_grid: cn("w-full border-collapse", defaultClassNames.month_grid),
        months: cn("relative flex flex-col gap-4 md:flex-row", defaultClassNames.months),
        nav: cn(
          "absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
          defaultClassNames.nav,
        ),
        outside: cn(
          "text-muted-foreground aria-selected:text-muted-foreground",
          defaultClassNames.outside,
        ),
        range_end: cn(
          "relative isolate z-0 rounded-r-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:left-0 after:w-4 after:bg-muted",
          defaultClassNames.range_end,
        ),
        range_middle: cn("rounded-none", defaultClassNames.range_middle),
        range_start: cn(
          "relative isolate z-0 rounded-l-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:right-0 after:w-4 after:bg-muted",
          defaultClassNames.range_start,
        ),
        root: cn("w-fit", defaultClassNames.root),
        today: cn(
          "rounded-(--cell-radius) bg-muted text-foreground data-[selected=true]:rounded-none",
          defaultClassNames.today,
        ),
        week: cn("mt-2 flex w-full", defaultClassNames.week),
        week_number: cn(
          "text-[0.8rem] text-muted-foreground select-none",
          defaultClassNames.week_number,
        ),
        week_number_header: cn("w-(--cell-size) select-none", defaultClassNames.week_number_header),
        weekday: cn(
          "flex-1 rounded-(--cell-radius) text-[0.8rem] font-normal text-muted-foreground select-none",
          defaultClassNames.weekday,
        ),
        weekdays: cn("flex", defaultClassNames.weekdays),
        ...classNames,
      }}
      components={{
        Chevron: ({ className: chevronClassName, orientation, ...chevronProps }) => {
          if (orientation === "left") {
            return <ChevronLeftIcon className={cn("size-4", chevronClassName)} {...chevronProps} />;
          }

          if (orientation === "right") {
            return (
              <ChevronRightIcon className={cn("size-4", chevronClassName)} {...chevronProps} />
            );
          }

          return <ChevronDownIcon className={cn("size-4", chevronClassName)} {...chevronProps} />;
        },
        DayButton: ({ ...dayButtonProps }) => (
          <CalendarDayButton locale={locale} {...dayButtonProps} />
        ),
        Root: ({ className: rootClassName, rootRef, ...rootProps }) => (
          <div data-slot="calendar" ref={rootRef} className={cn(rootClassName)} {...rootProps} />
        ),
        WeekNumber: ({ children, ...weekNumberProps }) => (
          <td {...weekNumberProps}>
            <div className="flex size-(--cell-size) items-center justify-center text-center">
              {children}
            </div>
          </td>
        ),
        ...components,
      }}
      {...props}
    />
  );
};

export { Calendar, CalendarDayButton };
