import { ArrowLeft } from "@geist-ui/icons";
import Link from "next/link";

import { UserButton } from "../../components/auth/user/user-button";
import styles from "./app-builder.module.css";

export function Header() {
  return (
    <header className={styles.header}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>
      <Link href="/" className={styles.back} prefetch={true}>
        <ArrowLeft size={17} aria-hidden="true" /> Back
      </Link>
      <span>New App</span>
      <div className={styles.headerActions}>
        <UserButton align="end" sideOffset={8} size="icon" />
      </div>
    </header>
  );
}
