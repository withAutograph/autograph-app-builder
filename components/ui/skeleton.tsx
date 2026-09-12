import { cn } from "@/lib/utils";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
