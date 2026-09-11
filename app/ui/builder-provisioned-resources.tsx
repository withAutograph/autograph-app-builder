import { AlertCircle, ExternalLink, RefreshCw } from "@geist-ui/icons";
import { FaGithub } from "react-icons/fa";
import { SiVercel } from "react-icons/si";

import type { BuilderProvisionResponse } from "../../lib/provisioning/contracts";
import styles from "./app-builder.module.css";

type ProvisionedResourcesProps = {
  githubSelected: boolean;
  vercelSelected: boolean;
  provisioning: BuilderProvisionResponse;
  provisioningEnabled: boolean;
  retrying?: "github" | "vercel";
  onRetry: (provider: "github" | "vercel") => void;
  providerSetupMessage: (
    provider: "GitHub" | "Vercel",
    result:
      BuilderProvisionResponse["github"] | BuilderProvisionResponse["vercel"],
  ) => string | undefined;
};

export function BuilderProvisionedResources({
  githubSelected,
  vercelSelected,
  provisioning,
  provisioningEnabled,
  retrying,
  onRetry,
  providerSetupMessage,
}: ProvisionedResourcesProps) {
  return (
    <div className={styles.resourceCards} aria-label="Provisioned resources">
      {(["github", "vercel"] as const).map((provider) => {
        const result = provisioning[provider];
        const selected =
          provider === "github" ? githubSelected : vercelSelected;
        if (!selected) return null;
        const label = provider === "github" ? "GitHub" : "Vercel";
        return (
          <article key={provider} data-status={result.status}>
            <span aria-hidden="true">
              {result.status === "failed" ? (
                <AlertCircle size={18} />
              ) : provider === "github" ? (
                <FaGithub />
              ) : (
                <SiVercel />
              )}
            </span>
            <div>
              <strong>{label}</strong>
              {result.status === "succeeded" ? (
                <a
                  href={
                    provider === "github" && "url" in result
                      ? result.url
                      : "dashboardUrl" in result
                        ? result.dashboardUrl
                        : "#"
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  {provider === "github" && "fullName" in result
                    ? result.fullName
                    : result.name}{" "}
                  <ExternalLink size={13} aria-hidden="true" />
                </a>
              ) : (
                <>
                  <small>{providerSetupMessage(label, result)}</small>
                  {result.status === "failed" ? (
                    <small className={styles.resourceRecovery}>
                      {result.retryable && provisioningEnabled
                        ? `Retry to finish setting up ${label}. Your app brief and completed resources are safe.`
                        : `Reconnect ${label}, then create the app again to finish setup.`}
                    </small>
                  ) : null}
                </>
              )}
            </div>
            {result.status !== "succeeded" &&
            result.retryable &&
            provisioningEnabled ? (
              <button
                type="button"
                disabled={retrying !== undefined}
                onClick={() => onRetry(provider)}
              >
                <RefreshCw size={14} aria-hidden="true" />
                {retrying === provider ? "Retrying…" : "Retry"}
              </button>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
