import Link from "next/link";

import { ArrowIcon, BrandLockup, SessionMark } from "./ui/brand";
import styles from "./ui/public-site.module.css";

const sessionStages = [
  { label: "Design", state: "complete" },
  { label: "Plan", state: "complete" },
  { label: "Create", state: "current" },
  { label: "Validate", state: "waiting" },
] as const;

const workflow = [
  {
    number: "1",
    title: "Describe",
    copy: "Tell Autograph what you want to build in your own words.",
  },
  {
    number: "2",
    title: "Review",
    copy: "See the plan and proposed changes, then provide input.",
  },
  {
    number: "3",
    title: "Continue",
    copy: "Pick up where the builder left off, in the same session.",
  },
] as const;

function SiteHeader() {
  return (
    <header className={styles.siteHeader}>
      <Link className={styles.brandLink} href="/" aria-label="Autograph home">
        <BrandLockup />
      </Link>
      <nav className={styles.primaryNav} aria-label="Primary navigation">
        <a href="#workflow">How it works</a>
        <Link href="/workspace">Workspace</Link>
      </nav>
      <Link className={styles.headerAction} href="/workspace">
        Open workspace
      </Link>
    </header>
  );
}

function SessionPreview() {
  return (
    <div
      className={styles.previewComposition}
      aria-label="App Builder session preview"
    >
      <span className={styles.backdropLetter} aria-hidden="true">
        A
      </span>
      <section className={styles.sessionFrame}>
        <header className={styles.sessionHeader}>
          <SessionMark />
          <div>
            <strong>App Builder session</strong>
            <span>Working</span>
          </div>
          <span className={styles.workingState}>
            <span aria-hidden="true" /> Working
          </span>
        </header>
        <div className={styles.sessionBody}>
          <ol className={styles.stageRail} aria-label="Builder workflow">
            {sessionStages.map((stage) => (
              <li key={stage.label} data-state={stage.state}>
                <span className={styles.stageNode} aria-hidden="true">
                  {stage.state === "complete" ? "✓" : ""}
                </span>
                <span>
                  <strong>{stage.label}</strong>
                  {stage.state === "waiting" ? (
                    <small>Needs input</small>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
          <div className={styles.sessionCanvas}>
            <div className={styles.sessionMessage}>
              <SessionMark />
              <div>
                <span />
                <span />
                <span />
              </div>
            </div>
            <div className={styles.sessionDocument} aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className={styles.reviewRequest}>
              <span className={styles.requestIcon} aria-hidden="true">
                !
              </span>
              <span>Review the proposed workspace changes</span>
              <ArrowIcon />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function Home() {
  return (
    <main className={styles.publicPage}>
      <SiteHeader />
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <h1>
            Build the app.
            <br />
            Keep the decisions.
          </h1>
          <p>
            Design, plan, create, and validate supported apps with a durable
            builder session.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryAction} href="/workspace">
              Open workspace <ArrowIcon />
            </Link>
            <a className={styles.textAction} href="#workflow">
              See how it works <ArrowIcon />
            </a>
          </div>
          <div className={styles.pathStart} aria-hidden="true">
            <span />
          </div>
        </div>
        <SessionPreview />
      </section>

      <section className={styles.workflowSection} id="workflow">
        <div className={styles.workflowHeading}>
          <h2>A session that keeps its place</h2>
          <div className={styles.workflowPath} aria-hidden="true">
            <span />
          </div>
        </div>
        <ol className={styles.workflowList}>
          {workflow.map((step) => (
            <li key={step.number}>
              <span className={styles.stepNumber}>{step.number}</span>
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
        <Link href="/workspace">
          Open workspace <ArrowIcon />
        </Link>
      </footer>
    </main>
  );
}
