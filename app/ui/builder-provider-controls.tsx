"use client";

import { Plus, PlusCircle } from "@geist-ui/icons";
import { FaGithub, FaLock, FaLockOpen } from "react-icons/fa";
import { SiBitbucket, SiCloudflare, SiGitlab, SiNetlify, SiVercel } from "react-icons/si";
import { ProviderChoiceSection } from "../../components/create-app/provider-choice-section";
import { githubStoreInViewModel } from "../../lib/integrations/store-in-view-model";
import type { DeploymentProvider, StorageProvider } from "./builder-types";
import { SearchCombobox } from "./search-combobox";
import type { ComboOption } from "./search-combobox";
import styles from "./app-builder.module.css";

const storageProviderOptions = [
  { available: true, icon: FaGithub, name: "GitHub", provider: "github" },
  { available: false, icon: SiGitlab, name: "GitLab", provider: "gitlab" },
  {
    available: false,
    icon: SiBitbucket,
    name: "Bitbucket",
    provider: "bitbucket",
  },
] as const;

const deploymentProviderOptions = [
  { available: true, icon: SiVercel, name: "Vercel", provider: "vercel" },
  { available: false, icon: SiNetlify, name: "Netlify", provider: "netlify" },
  {
    available: false,
    icon: SiCloudflare,
    name: "Cloudflare",
    provider: "cloudflare",
  },
] as const;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function DeployToSection({
  bare = false,
  available,
  comingSoonEnabled = false,
  connected,
  onConnect,
  onProviderChange,
  onTeamChange,
  selected,
  team,
  teamOptions,
}: {
  bare?: boolean;
  available: boolean;
  comingSoonEnabled?: boolean;
  connected: boolean;
  onConnect: () => void;
  onProviderChange: (provider: DeploymentProvider) => void;
  onTeamChange: (value: string) => void;
  selected: DeploymentProvider | null;
  team: string;
  teamOptions: ComboOption[];
}) {
  return (
    <ProviderChoiceSection
      bare={bare}
      className={`${styles.sectionField} ${styles.deploySection}`}
      section="deploy-to"
      title="Deploy to"
      description="Where do you want to deploy this app?"
      label="Deployment provider"
      name="deployment-provider"
      gridClassName={`${styles.optionGrid} ${styles.providerChoiceGrid}`}
      unavailableClassName={styles.unavailableOption}
      options={deploymentProviderOptions
        .map((option) => ({
          ...option,
          available: option.available && available,
        }))
        .filter((option) => comingSoonEnabled || option.available)}
      selected={selected}
      onChange={onProviderChange}
    >
      {selected === "vercel" && available ? (
        <div className={styles.providerPanel} id="deployment-provider-vercel">
          <div className={styles.integrationField}>
            <span className={styles.fieldLabel}>
              Vercel Team <small aria-hidden="true">Optional</small>
            </span>
            {connected ? (
              <SearchCombobox
                label="Select a Vercel Team"
                value={team}
                options={teamOptions}
                onChange={onTeamChange}
                inputId="vercel-team"
                prefix={<span className={styles.teamDot} data-team={team} />}
                optionIcon={(option) => (
                  <span className={styles.teamDot} data-team={option.value} />
                )}
                footerIcon={<PlusCircle size={18} />}
                detailPills
                menuFooter={{
                  label: "Connect another Vercel team",
                  value: "create-team",
                }}
                onFooterSelect={onConnect}
              />
            ) : (
              <button
                className={styles.connectProvider}
                type="button"
                id="vercel-team"
                onClick={onConnect}
              >
                Connect to Vercel
              </button>
            )}
          </div>
        </div>
      ) : null}
    </ProviderChoiceSection>
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function StoreInSection({
  bare = false,
  available,
  comingSoonEnabled = false,
  connected,
  gitScope,
  gitScopeOptions,
  onConnect,
  onGitScopeChange,
  onPrivacyChange,
  onProviderChange,
  onRepositoryChange,
  privateRepository,
  repository,
  selected,
}: {
  bare?: boolean;
  available: boolean;
  comingSoonEnabled?: boolean;
  connected: boolean;
  gitScope: string;
  gitScopeOptions: ComboOption[];
  onConnect: () => void;
  onGitScopeChange: (value: string) => void;
  onPrivacyChange: (value: boolean) => void;
  onProviderChange: (provider: StorageProvider) => void;
  onRepositoryChange: (value: string) => void;
  privateRepository: boolean;
  repository: string;
  selected: StorageProvider | null;
}) {
  const githubView = githubStoreInViewModel({
    action: connected ? "update" : "connect",
    scopes: gitScopeOptions.map((scope) => ({
      id: scope.value,
      label: scope.label,
      ...(scope.detail === undefined ? {} : { detail: scope.detail }),
    })),
  });
  return (
    <ProviderChoiceSection
      bare={bare}
      className={`${styles.sectionField} ${styles.storeSection}`}
      section="store-in"
      title="Store in"
      description="Where do you want to store this app?"
      label="Storage provider"
      name="storage-provider"
      gridClassName={`${styles.optionGrid} ${styles.providerChoiceGrid}`}
      unavailableClassName={styles.unavailableOption}
      options={storageProviderOptions
        .map((option) => ({
          ...option,
          available: option.available && available,
        }))
        .filter((option) => comingSoonEnabled || option.available)}
      selected={selected}
      onChange={onProviderChange}
    >
      {selected === "github" && available ? (
        <div className={styles.providerPanel} id="storage-provider-github">
          <div className={styles.repoScope}>
            <div className={`${styles.repoRow} ${gitScope ? styles.repoRowWithRepository : ""}`}>
              <div className={styles.integrationField}>
                <span className={styles.fieldLabel}>
                  Git Scope <small aria-hidden="true">Optional</small>
                </span>
                {connected ? (
                  <SearchCombobox
                    label="Git Scope"
                    value={gitScope}
                    options={gitScopeOptions}
                    onChange={onGitScopeChange}
                    inputId="git-scope"
                    prefix={<FaGithub size={16} />}
                    optionIcon={() => <FaGithub size={16} />}
                    footerIcon={<Plus size={21} />}
                    menuFooter={{
                      label: githubView.actionLabel,
                      value: "add-github",
                    }}
                    onFooterSelect={onConnect}
                  />
                ) : (
                  <button
                    className={styles.connectProvider}
                    type="button"
                    id="git-scope"
                    onClick={onConnect}
                  >
                    {githubView.actionLabel}
                  </button>
                )}
              </div>
              {gitScope ? (
                <>
                  <span className={styles.slash} aria-hidden="true">
                    /
                  </span>
                  <div className={styles.repoLabel}>
                    <span className={styles.fieldLabel}>
                      {privateRepository ? "Private" : "Public"} Repository Name{" "}
                      <small aria-hidden="true">Optional</small>
                    </span>
                    <div className={styles.lockedInput}>
                      <input
                        id="repository-name"
                        name="repository-name"
                        autoComplete="off"
                        spellCheck={false}
                        value={repository}
                        onChange={(event) => onRepositoryChange(event.target.value)}
                        placeholder="my-app"
                      />
                      <label className={styles.privacyToggle} aria-label="Private repository">
                        <input
                          type="checkbox"
                          checked={privateRepository}
                          onChange={(event) => onPrivacyChange(event.target.checked)}
                        />
                        <span>
                          <i>
                            {privateRepository ? <FaLock size={11} /> : <FaLockOpen size={12} />}
                          </i>
                        </span>
                        <em role="tooltip">
                          This repository will be {privateRepository ? "private" : "public"}.
                        </em>
                      </label>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </ProviderChoiceSection>
  );
}
