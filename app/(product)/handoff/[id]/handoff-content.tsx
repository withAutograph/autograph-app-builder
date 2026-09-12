import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getBuilderHandoffPageData } from "../../../../lib/handoff/deployment";
import { Header } from "../../../ui/builder-shell";
import { CreateAnotherAppLink } from "../../../ui/create-another-app-link";
import { HandoffControls } from "../../../ui/handoff-controls";
import { HandoffProvisioningProgress } from "../../../ui/handoff-provisioning-progress";

import styles from "../../../ui/app-builder.module.css";
import handoffStyles from "../../../ui/handoff.module.css";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function HandoffContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const requestHeaders = await headers();
  let data;
  try {
    data = await getBuilderHandoffPageData({
      environment: process.env,
      handoffId: id,
      headers: requestHeaders,
    });
  } catch {
    return (
      <div className={styles.appShell}>
        <Header />
        <main id="main-content" className={styles.flowPage}>
          <section className={styles.readyCard}>
            <h1>Handoff unavailable</h1>
            <p>
              Use the same Autograph account and workspace as the web form. If you are already
              signed into that account, try reloading this page.
            </p>
            <Link
              href={`/auth/sign-in?callbackURL=${encodeURIComponent(`/handoff/${encodeURIComponent(id)}`)}`}
            >
              Sign in with the same account
            </Link>
          </section>
        </main>
      </div>
    );
  }
  if (!data) {
    redirect(
      `/auth/sign-in?callbackURL=${encodeURIComponent(`/handoff/${encodeURIComponent(id)}`)}`,
    );
  }
  const { intent, ...controls } = data;
  const github = intent.provisioning?.github;
  const vercel = intent.provisioning?.vercel;
  const returnTo = encodeURIComponent(`/handoff/${encodeURIComponent(data.handoffId)}`);
  return (
    <div className={styles.appShell}>
      <Header />
      <main id="main-content" className={styles.flowPage}>
        <section className={`${styles.readyCard} ${handoffStyles.card}`}>
          <h1>{intent.appName}</h1>
          <p>Your prepared app and existing provider connections are saved with Autograph.</p>
          <div className={handoffStyles.resources} aria-label="Prepared resources">
            <article>
              <div>
                <strong>GitHub repository</strong>
                {github?.status === "succeeded" ? (
                  <a href={github.url} target="_blank" rel="noreferrer">
                    {github.fullName}
                  </a>
                ) : (
                  <span>
                    {intent.repository.resolvedFullName ?? intent.repository.requestedName} (
                    {intent.repository.private ? "Private" : "Public"})
                  </span>
                )}
                {github?.status === "failed" ? (
                  <small>
                    GitHub setup needs attention. Continue in Autograph to recover; your saved brief
                    is retained.
                  </small>
                ) : null}
                {github?.status === "failed" &&
                ["credential_unavailable", "installation_inactive"].includes(github.code) ? (
                  <Link href={`/github/installations?returnTo=${returnTo}`}>Reconnect GitHub</Link>
                ) : null}
              </div>
            </article>
            {vercel && !(vercel.status === "skipped" && vercel.code === "not_selected") ? (
              <article>
                <div>
                  <strong>Vercel project</strong>
                  {vercel.status === "succeeded" ? (
                    <>
                      <a href={vercel.dashboardUrl} target="_blank" rel="noreferrer">
                        {vercel.name}
                      </a>
                      <small>{vercel.scope.slug}</small>
                    </>
                  ) : (
                    <small>
                      Vercel setup needs attention. Continue in Autograph to recover without
                      recreating completed resources.
                    </small>
                  )}
                  {vercel.status === "failed" &&
                  ["credential_unavailable", "installation_inactive"].includes(vercel.code) ? (
                    <Link href={`/vercel/installations?returnTo=${returnTo}`}>
                      Reconnect Vercel
                    </Link>
                  ) : null}
                </div>
              </article>
            ) : null}
          </div>
          {intent.connections.length ? (
            <p>App connections: {intent.connections.join(", ")}</p>
          ) : null}
          <details>
            <summary>Prepared brief</summary>
            <p style={{ whiteSpace: "pre-wrap" }}>{intent.brief}</p>
          </details>
          {intent.provisioning && data.provisioningRevision ? (
            <HandoffProvisioningProgress
              handoffId={data.handoffId}
              initial={{
                revision: data.provisioningRevision,
                provisioning: intent.provisioning,
              }}
            />
          ) : null}
          <HandoffControls key={data.handoffId} initial={controls} />
          <CreateAnotherAppLink />
        </section>
      </main>
    </div>
  );
}
