import Image from "next/image";

import autographIcon from "../../assets/autograph-icon.png";
import styles from "./app-builder.module.css";

export function AutographMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={styles.brand} data-compact={compact || undefined}>
      <Image className={styles.brandMark} src={autographIcon} width={23} height={23} alt="" />
      <span>Autograph</span>
    </span>
  );
}
