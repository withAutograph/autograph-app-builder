import Link from "next/link";

export function CreateAnotherAppLink() {
  return (
    <Link href="/" prefetch={true}>
      Create another app
    </Link>
  );
}
