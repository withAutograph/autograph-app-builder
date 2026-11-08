import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { PreviewActivationStore } from "./preview-activation";

const stableId = (prefix: string, value: string) =>
  `${prefix}_${createHash("sha256").update(value).digest("hex")}`;

export const createInvitedUserProvisioner =
  (sql: Sql): PreviewActivationStore["provisionInvitedUser"] =>
  async (input) =>
    await sql.begin(async (transaction) => {
      const users = await transaction<
        {
          id: string;
          name: string;
          email: string;
          email_verified: boolean;
        }[]
      >`select id, name, email, email_verified from "user" where id = ${input.userId} or email = ${input.email} for update`;
      const accountId = stableId("account", `github:${input.githubAccountId}`);
      const accounts = await transaction<
        {
          id: string;
          issuer: string;
          account_id: string;
          provider_id: string;
          user_id: string;
          password: string | null;
        }[]
      >`select id, issuer, account_id, provider_id, user_id, password from account where id = ${accountId} or (issuer = 'local:oauth:github' and account_id = ${input.githubAccountId}) for update`;
      const memberships = await transaction<
        {
          active: boolean;
        }[]
      >`select active from hosted_workspace_membership where issuer = ${input.issuer} and audience = ${input.resource} and workspace_id = ${input.workspaceId} and owner_user_id = ${input.userId} for update`;
      let userRowsAffected = 0;
      let accountRowsAffected = 0;
      let membershipRowsAffected = 0;
      if (users.length === 0) {
        const now = new Date(input.requestedAt);
        await transaction`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${input.userId}, ${input.githubLogin}, ${input.email}, true, ${now}, ${now})`;
        userRowsAffected = 1;
      } else {
        const identityConflict = "Invited user identity conflicts with an existing row.";
        if (
          users.length !== 1 ||
          users[0]?.id !== input.userId ||
          users[0]?.email !== input.email
        ) {
          throw new Error(identityConflict);
        }
        if (users[0]?.name !== input.githubLogin || users[0]?.email_verified !== true) {
          throw new Error(identityConflict);
        }
      }
      if (accounts.length === 0) {
        const now = new Date(input.requestedAt);
        await transaction`insert into account (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at) values (${accountId}, 'local:oauth:github', ${input.githubAccountId}, 'github', ${input.userId}, null, ${now}, ${now})`;
        accountRowsAffected = 1;
      } else {
        const [account] = accounts;
        const invalidAccountIdentity =
          accounts.length !== 1 ||
          account?.id !== accountId ||
          account.issuer !== "local:oauth:github" ||
          account.account_id !== input.githubAccountId;
        if (
          invalidAccountIdentity ||
          account.provider_id !== "github" ||
          account.user_id !== input.userId ||
          account.password !== null
        ) {
          throw new Error("Invited GitHub identity conflicts with an existing row.");
        }
      }
      if (memberships.length === 0) {
        const now = new Date(input.requestedAt);
        await transaction`insert into hosted_workspace_membership (issuer, audience, workspace_id, owner_user_id, active, updated_at) values (${input.issuer}, ${input.resource}, ${input.workspaceId}, ${input.userId}, true, ${now})`;
        membershipRowsAffected = 1;
      } else if (memberships.length !== 1 || memberships[0]?.active !== true) {
        throw new Error("Invited user membership conflicts with an existing row.");
      }
      return {
        accountRowsAffected,
        membershipRowsAffected,
        userRowsAffected,
      };
    });
