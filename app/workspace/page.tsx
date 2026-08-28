import Link from "next/link";

import { ArrowIcon, BrandLockup } from "../ui/brand";
import styles from "../ui/public-site.module.css";
import { WorkspaceBrief } from "./workspace-brief";

const handoffSteps = [
  {
    title: "Install Autograph App Builder",
    copy: "Add the MCP client to your preferred AI workspace.",
  },
  {
    title: "Open a new task",
    copy: "Start a fresh conversation or task in your AI workspace.",
  },
  {
    title: "Mention @Autograph App Builder and paste your brief",
    copy: "Hand off the context you shaped here to the App Builder.",
  },
] as const;

export default function WorkspacePage() {
  return (
    <main className={styles.workspacePage}>
      <header className={styles.workspaceHeader}>
        <Link className={styles.brandLink} href="/" aria-label="Autograph home">
          <BrandLockup />
        </Link>
        <Link className={styles.backLink} href="/">
          <ArrowIcon className={styles.backArrow} /> Back home
        </Link>
      </header>

      <WorkspaceBrief />

      <section
        className={styles.handoffSection}
        aria-labelledby="handoff-title"
      >
        <h2 id="handoff-title">Continue in your AI workspace</h2>
        <ol>
          {handoffSteps.map((step, index) => (
            <li key={step.title}>
              <span className={styles.stepNumber}>{index + 1}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer className={styles.siteFooter}>
        <BrandLockup compact />
        <Link href="/">
          Back home <ArrowIcon />
        </Link>
      </footer>
    </main>
  );
}
