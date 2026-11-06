"use client";

import type { ComponentProps } from "react";
import type {
  PopoverDescriptionProps,
  PopoverPopupProps,
  PopoverPositionerProps,
  PopoverTitleProps,
} from "@base-ui/react/popover";
import {
  Description as PopoverDescriptionPrimitive,
  Popup as PopoverPopupPrimitive,
  Portal as PopoverPortalPrimitive,
  Positioner as PopoverPositionerPrimitive,
  Root as PopoverRootPrimitive,
  Title as PopoverTitlePrimitive,
  Trigger as PopoverTriggerPrimitive,
} from "@base-ui/react/popover";

import { cn } from "@/lib/utils";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function Popover({ ...props }: PopoverRootPrimitive.Props) {
  return <PopoverRootPrimitive data-slot="popover" {...props} />;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function PopoverTrigger({ ...props }: PopoverTriggerPrimitive.Props) {
  return <PopoverTriggerPrimitive data-slot="popover-trigger" {...props} />;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  ...props
}: Omit<PopoverPopupProps, "align" | "alignOffset" | "side" | "sideOffset"> &
  Pick<PopoverPositionerProps, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <PopoverPortalPrimitive>
      <PopoverPositionerPrimitive
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <PopoverPopupPrimitive
          data-slot="popover-content"
          className={cn(
            "z-50 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </PopoverPositionerPrimitive>
    </PopoverPortalPrimitive>
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function PopoverHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-0.5 text-sm", className)}
      {...props}
    />
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function PopoverTitle({ className, ...props }: PopoverTitleProps) {
  return (
    <PopoverTitlePrimitive
      data-slot="popover-title"
      className={cn("font-medium", className)}
      {...props}
    />
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function PopoverDescription({ className, ...props }: PopoverDescriptionProps) {
  return (
    <PopoverDescriptionPrimitive
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger };
