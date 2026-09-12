import type { GitHubMutationReceipt, GitHubPublicationReceiptStore } from "./github-publication";

export class GitHubPublicationTestStore implements GitHubPublicationReceiptStore {
  readonly values = new Map<string, GitHubMutationReceipt>();
  rejectTerminal = false;

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async read(key: string) {
    return this.values.get(key);
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async compareAndSet(key: string, expected: string | undefined, value: GitHubMutationReceipt) {
    if (this.values.get(key)?.digest !== expected) return false;
    if (this.rejectTerminal && value.status !== "pending") return false;
    this.values.set(key, value);
    return true;
  }
}
