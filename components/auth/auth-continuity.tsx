"use client";

import { ArrowLeft } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";

import autographIcon from "@/assets/autograph-icon.png";

const anonymousBriefStorageKey = "autograph-app-brief";

export function AuthContinuity({
  children,
  action = "sign-in",
}: {
  children: ReactNode;
  action?: "sign-in" | "sign-up";
}) {
  const hasSavedBrief = useSyncExternalStore(
    () => () => undefined,
    () =>
      (sessionStorage.getItem(anonymousBriefStorageKey) ?? "").trim().length >
      0,
    () => false,
  );

  return (
    <div className="w-full max-w-sm">
      <Link
        href="/"
        className="mx-auto flex w-fit items-center gap-2 rounded-md text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
        aria-label="Autograph App Builder home"
      >
        <Image src={autographIcon} alt="" width={32} height={32} priority />
        <span className="flex flex-col leading-none">
          <strong className="text-sm font-semibold">Autograph</strong>
          <span className="mt-1 text-xs text-muted-foreground">
            App Builder
          </span>
        </span>
      </Link>

      {hasSavedBrief ? (
        <p
          className="mt-4 text-center text-sm text-muted-foreground"
          role="status"
        >
          Your brief is saved. {action === "sign-in" ? "Sign in" : "Sign up"} to
          continue building.
        </p>
      ) : null}

      <div className="mt-4">{children}</div>

      <div className="mt-12 text-center">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {hasSavedBrief ? "Back to edit your brief" : "Back to App Builder"}
        </Link>
      </div>
    </div>
  );
}
