import { cn } from "@/lib/utils";
import { Loader2Icon } from "lucide-react";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
