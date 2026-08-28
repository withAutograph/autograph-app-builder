import Link from "next/link";

import { ArrowIcon, BrandLockup, BrandMark } from "./ui/brand";
import styles from "./ui/public-site.module.css";

const appBuildStages = [
  { label: "Design", state: "complete" },
  { label: "Plan", state: "complete" },
  { label: "Create", state: "current" },
  { label: "Validate", state: "waiting" },
] as const;

const workflow = [
  {
    number: "1",
    title: "Describe",
    copy: "Tell Autograph App Builder what you want to build in your own words.",
  },
  {
    number: "2",
    title: "Review",
    copy: "See the plan and proposed changes, then provide input.",
  },
  {
    number: "3",
    title: "Continue",
    copy: "Pick up where the app build left off.",
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

function ProgressPreview() {
  return (
    <section
      className={styles.previewComposition}
      aria-label="Autograph App Builder progress"
    >
      <span className={styles.backdropLetter} aria-hidden="true">
        A
      </span>
      <section className={styles.sessionFrame}>
        <header className={styles.sessionHeader}>
          <BrandMark />
          <div>
            <strong>Autograph App Builder progress</strong>
            <span>Working</span>
          </div>
          <span className={styles.workingState}>
            <span aria-hidden="true" /> Working
          </span>
        </header>
        <div className={styles.sessionBody}>
          <ol
            className={styles.stageRail}
            aria-label="Autograph App Builder workflow"
          >
            {appBuildStages.map((stage) => (
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
              <BrandMark />
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
    </section>
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
            Design, plan, create, and validate supported apps with a durable app
            build.
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
        <ProgressPreview />
      </section>

      <section className={styles.workflowSection} id="workflow">
        <div className={styles.workflowHeading}>
          <h2>An app build that keeps its place</h2>
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
