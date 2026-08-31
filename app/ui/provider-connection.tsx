import { ArrowLeft } from "@geist-ui/icons";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

type ProviderConnectionProps = {
  action: string;
  buttonLabel: string;
  children: ReactNode;
  description: string;
  icon: ReactNode;
  returnTo: string;
  resumeKey?: string;
  title: string;
};

export function ProviderConnection({
  action,
  buttonLabel,
  children,
  description,
  icon,
  returnTo,
  resumeKey,
  title,
}: ProviderConnectionProps) {
  return (
    <main className="min-h-svh bg-background text-foreground">
      <header className="flex h-14 items-center border-b bg-background px-4 text-sm sm:px-8">
        <Link
          className="inline-flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          href={
            resumeKey
              ? { pathname: returnTo, query: { resume: resumeKey } }
              : returnTo
          }
        >
          <ArrowLeft size={17} aria-hidden="true" /> Back
        </Link>
        <span className="mx-auto font-medium">New App</span>
        <span aria-hidden="true" className="w-12" />
      </header>
      <Card className="mx-auto mt-8 w-[calc(100%-2rem)] max-w-md sm:mt-12">
        <CardHeader className="gap-4">
          <span
            className="grid size-10 place-items-center rounded-lg border bg-background text-foreground shadow-sm"
            aria-hidden="true"
          >
            {icon}
          </span>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription className="leading-6">{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {children}
          <form
            className="flex flex-col gap-4"
            method="post"
            action={action}
          >
            <input name="returnTo" type="hidden" value={returnTo} />
            {resumeKey ? (
              <input name="resumeKey" type="hidden" value={resumeKey} />
            ) : null}
            <Button className="w-full" type="submit">
              {buttonLabel}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export function ProviderConnectionNotice({
  children,
  status,
}: {
  children: ReactNode;
  status: "error" | "success";
}) {
  return (
    <p
      className={cn(
        "rounded-lg border px-3 py-2.5 text-sm leading-5",
        status === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      )}
      role={status === "error" ? "alert" : "status"}
    >
      {children}
    </p>
  );
}
