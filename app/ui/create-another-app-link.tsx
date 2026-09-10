"use client";

import Link from "next/link";

import { clearActiveProvisioning } from "./builder-session";

export function CreateAnotherAppLink() {
  return (
    <Link href="/" onClick={clearActiveProvisioning}>
      Create another app
    </Link>
  );
}
