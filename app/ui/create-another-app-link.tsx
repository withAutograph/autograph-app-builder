import Link from "next/link";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function CreateAnotherAppLink() {
  return (
    <Link href="/" prefetch={true}>
      Create another app
    </Link>
  );
}
