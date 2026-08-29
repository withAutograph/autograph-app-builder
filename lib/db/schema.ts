import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Better Auth 1.7.1 core + jwt + MCP OAuth Provider schema. These exports use
// the plugin model names intentionally: the Drizzle adapter resolves models by
// object key, while the SQL names remain explicit and stable.
export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("user_email_uidx").on(table.email)],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
    impersonatedBy: text("impersonated_by"),
  },
  (table) => [
    uniqueIndex("session_token_uidx").on(table.token),
    index("session_user_id_idx").on(table.userId),
  ],
);

export const organization = pgTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    metadata: text("metadata"),
    issuer: text("issuer").notNull(),
    audience: text("audience").notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    uniqueIndex("organization_slug_uidx").on(table.slug),
    uniqueIndex("organization_authority_uidx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
    ),
  ],
);

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("member_organization_user_uidx").on(
      table.organizationId,
      table.userId,
    ),
    index("member_organization_id_idx").on(table.organizationId),
    index("member_user_id_idx").on(table.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organization_id_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("account_issuer_account_id_uidx").on(
      table.issuer,
      table.accountId,
    ),
    index("account_user_id_idx").on(table.userId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClient = pgTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("client_credentials_scopes")
      .array()
      .default([]),
    userId: text("user_id").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean(
      "backchannel_logout_session_required",
    ),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (table) => [
    uniqueIndex("oauth_client_client_id_uidx").on(table.clientId),
    index("oauth_client_user_id_idx").on(table.userId),
  ],
);

export const oauthResource = pgTable(
  "oauth_resource",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    name: text("name").notNull(),
    accessTokenTtl: integer("access_token_ttl"),
    refreshTokenTtl: integer("refresh_token_ttl"),
    signingAlgorithm: text("signing_algorithm"),
    signingKeyId: text("signing_key_id"),
    allowedScopes: text("allowed_scopes").array(),
    customClaims: jsonb("custom_claims"),
    dpopBoundAccessTokensRequired: boolean(
      "dpop_bound_access_tokens_required",
    ).default(false),
    disabled: boolean("disabled").default(false),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    policyVersion: integer("policy_version").default(1),
    metadata: jsonb("metadata"),
  },
  (table) => [
    uniqueIndex("oauth_resource_identifier_uidx").on(table.identifier),
  ],
);

export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("oauth_client_resource_client_resource_uidx").on(
      table.clientId,
      table.resourceId,
    ),
    index("oauth_client_resource_client_id_idx").on(table.clientId),
    index("oauth_client_resource_resource_id_idx").on(table.resourceId),
  ],
);

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }),
    revoked: timestamp("revoked", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: timestamp("rotation_replay_expires_at", {
      withTimezone: true,
    }),
    authTime: timestamp("auth_time", { withTimezone: true }),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    uniqueIndex("oauth_refresh_token_token_uidx").on(table.token),
    index("oauth_refresh_token_client_id_idx").on(table.clientId),
    index("oauth_refresh_token_session_id_idx").on(table.sessionId),
    index("oauth_refresh_token_user_id_idx").on(table.userId),
    index("oauth_refresh_token_authorization_code_id_idx").on(
      table.authorizationCodeId,
    ),
  ],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token"),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => user.id),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }),
    revoked: timestamp("revoked", { withTimezone: true }),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    uniqueIndex("oauth_access_token_token_uidx").on(table.token),
    index("oauth_access_token_client_id_idx").on(table.clientId),
    index("oauth_access_token_session_id_idx").on(table.sessionId),
    index("oauth_access_token_user_id_idx").on(table.userId),
    index("oauth_access_token_authorization_code_id_idx").on(
      table.authorizationCodeId,
    ),
    index("oauth_access_token_refresh_id_idx").on(table.refreshId),
  ],
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId),
    userId: text("user_id").references(() => user.id),
    referenceId: text("reference_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    index("oauth_consent_client_id_idx").on(table.clientId),
    index("oauth_consent_user_id_idx").on(table.userId),
  ],
);

export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const hostedWorkspaceMemberships = pgTable(
  "hosted_workspace_membership",
  {
    issuer: text("issuer").notNull(),
    audience: text("audience").notNull(),
    workspaceId: text("workspace_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    active: boolean("active").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "hosted_workspace_membership_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
      ],
    }),
  ],
);

export const agentSessions = pgTable(
  "agent_session",
  {
    issuer: text("issuer").notNull(),
    audience: text("audience").notNull(),
    workspaceId: text("workspace_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    sessionId: text("session_id").notNull(),
    adapterSessionId: text("adapter_session_id").notNull(),
    record: jsonb("record").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "agent_session_tenant_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.sessionId,
      ],
    }),
    index("agent_session_owner_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
    ),
    index("agent_session_retention_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt,
    ),
    uniqueIndex("agent_session_adapter_id_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.adapterSessionId,
    ),
  ],
);

export const agentOperations = pgTable(
  "agent_operation",
  {
    issuer: text("issuer").notNull(),
    audience: text("audience").notNull(),
    workspaceId: text("workspace_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    operationId: text("operation_id").notNull(),
    sessionId: text("session_id"),
    kind: text("kind").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    state: text("state").notNull(),
    record: jsonb("record").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "agent_operation_tenant_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.operationId,
      ],
    }),
    uniqueIndex("agent_operation_idempotency_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.kind,
      table.clientRequestId,
    ),
    index("agent_operation_retention_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt,
      table.state,
    ),
  ],
);

export const sandboxExecutionLeases = pgTable(
  "sandbox_execution_lease",
  {
    issuer: text("issuer").notNull(),
    audience: text("audience").notNull(),
    workspaceId: text("workspace_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    adapterSessionId: text("adapter_session_id").notNull(),
    providerSandboxId: text("provider_sandbox_id").notNull(),
    epoch: integer("epoch").notNull(),
    state: text("state").notNull(),
    policyDigest: text("policy_digest").notNull(),
    record: jsonb("record").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: "sandbox_execution_lease_tenant_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.adapterSessionId,
      ],
    }),
    index("sandbox_execution_lease_workspace_active_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.state,
      table.expiresAt,
    ),
    index("sandbox_execution_lease_subject_active_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.state,
      table.expiresAt,
    ),
    index("sandbox_execution_lease_orphan_idx").on(
      table.state,
      table.expiresAt,
    ),
  ],
);

export const githubPublicationProposals = pgTable(
  "github_publication_proposal",
  {
    proposalDigest: text("proposal_digest").notNull(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    proposal: jsonb("proposal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "github_publication_proposal_pk",
      columns: [table.proposalDigest],
    }),
    uniqueIndex("github_publication_proposal_idempotency_idx").on(
      table.kind,
      table.idempotencyKey,
    ),
    check(
      "github_publication_proposal_digest_check",
      sql`${table.proposalDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "github_publication_proposal_idempotency_key_check",
      sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "github_publication_proposal_kind_check",
      sql`${table.kind} IN ('fresh-repository', 'draft-pull-request')`,
    ),
    check(
      "github_publication_proposal_record_check",
      sql`jsonb_typeof(${table.proposal}) = 'object'`,
    ),
  ],
);

export const githubPublicationJournals = pgTable(
  "github_publication_journal",
  {
    proposalDigest: text("proposal_digest").notNull(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    status: text("status").notNull(),
    record: jsonb("record").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "github_publication_journal_pk",
      columns: [table.proposalDigest],
    }),
    uniqueIndex("github_publication_journal_idempotency_idx").on(
      table.idempotencyKey,
    ),
    index("github_publication_journal_status_idx").on(
      table.status,
      table.updatedAt,
    ),
    check(
      "github_publication_journal_proposal_digest_check",
      sql`${table.proposalDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "github_publication_journal_receipt_digest_check",
      sql`${table.receiptDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "github_publication_journal_idempotency_key_check",
      sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "github_publication_journal_kind_check",
      sql`${table.kind} IN ('fresh-repository', 'draft-pull-request')`,
    ),
    check(
      "github_publication_journal_status_check",
      sql`${table.status} IN ('pending', 'failed', 'succeeded')`,
    ),
    check(
      "github_publication_journal_record_check",
      sql`jsonb_typeof(${table.record}) = 'object'`,
    ),
    check(
      "github_publication_journal_timestamp_check",
      sql`${table.createdAt} <= ${table.updatedAt}`,
    ),
  ],
);

const hostedGitHubTenantColumns = {
  issuer: text("issuer").notNull(),
  audience: text("audience").notNull(),
  workspaceId: text("workspace_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
};

export const hostedGitHubInstallations = pgTable(
  "hosted_github_installation",
  {
    ...hostedGitHubTenantColumns,
    installationId: text("installation_id").notNull(),
    accountId: text("account_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    active: boolean("active").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "hosted_github_installation_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
      ],
    }),
    uniqueIndex("hosted_github_installation_id_tenant_uidx").on(
      table.installationId,
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
    ),
    uniqueIndex("hosted_github_installation_id_uidx").on(table.installationId),
    check(
      "hosted_github_installation_id_check",
      sql`${table.installationId} ~ '^[1-9][0-9]*$'`,
    ),
    check(
      "hosted_github_installation_account_id_check",
      sql`${table.accountId} ~ '^[1-9][0-9]*$'`,
    ),
    check(
      "hosted_github_installation_account_type_check",
      sql`${table.accountType} IN ('Organization', 'User')`,
    ),
  ],
);

/** Multi-installation GitHub bindings used by App Builder selection. The
 * original single binding remains the publication-runtime compatibility row;
 * connecting another scope never broadens publication authority implicitly. */
export const hostedGitHubInstallationBindings = pgTable(
  "hosted_github_installation_binding",
  {
    ...hostedGitHubTenantColumns,
    installationId: text("installation_id").notNull(),
    accountId: text("account_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    active: boolean("active").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "hosted_github_installation_binding_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.installationId,
      ],
    }),
    uniqueIndex("hosted_github_installation_binding_id_uidx").on(
      table.installationId,
    ),
    check(
      "hosted_github_installation_binding_id_check",
      sql`${table.installationId} ~ '^[1-9][0-9]*$'`,
    ),
    check(
      "hosted_github_installation_binding_account_id_check",
      sql`${table.accountId} ~ '^[1-9][0-9]*$'`,
    ),
    check(
      "hosted_github_installation_binding_account_type_check",
      sql`${table.accountType} IN ('Organization', 'User')`,
    ),
  ],
);

export const hostedVercelInstallations = pgTable(
  "hosted_vercel_installation",
  {
    ...hostedGitHubTenantColumns,
    installationId: text("installation_id").notNull(),
    scopeId: text("scope_id").notNull(),
    scopeType: text("scope_type").notNull(),
    displayName: text("display_name").notNull(),
    slug: text("slug").notNull(),
    plan: text("plan").notNull(),
    encryptedToken: text("encrypted_token").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    tokenKeyVersion: text("token_key_version").notNull(),
    active: boolean("active").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "hosted_vercel_installation_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.installationId,
      ],
    }),
    uniqueIndex("hosted_vercel_installation_id_uidx").on(table.installationId),
    check(
      "hosted_vercel_installation_scope_type_check",
      sql`${table.scopeType} IN ('team', 'user')`,
    ),
  ],
);

export const vercelInstallationAuthorizationStates = pgTable(
  "vercel_installation_authorization_state",
  {
    stateDigest: text("state_digest").primaryKey(),
    ...hostedGitHubTenantColumns,
    authorityDigest: text("authority_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    index("vercel_installation_authorization_state_expiry_idx").on(
      table.expiresAt,
    ),
    check(
      "vercel_installation_authorization_state_digest_check",
      sql`${table.stateDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "vercel_installation_authorization_authority_digest_check",
      sql`${table.authorityDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "vercel_installation_authorization_state_time_check",
      sql`${table.createdAt} < ${table.expiresAt}`,
    ),
    check(
      "vercel_installation_authorization_state_consumed_check",
      sql`${table.consumedAt} IS NULL OR (${table.consumedAt} >= ${table.createdAt} AND ${table.consumedAt} <= ${table.expiresAt})`,
    ),
  ],
);

export const githubInstallationAuthorizationStates = pgTable(
  "github_installation_authorization_state",
  {
    stateDigest: text("state_digest").primaryKey(),
    ...hostedGitHubTenantColumns,
    authorityDigest: text("authority_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    index("github_installation_authorization_state_expiry_idx").on(
      table.expiresAt,
    ),
    check(
      "github_installation_authorization_state_digest_check",
      sql`${table.stateDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "github_installation_authorization_authority_digest_check",
      sql`${table.authorityDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "github_installation_authorization_state_time_check",
      sql`${table.createdAt} < ${table.expiresAt}`,
    ),
    check(
      "github_installation_authorization_state_consumed_check",
      sql`${table.consumedAt} IS NULL OR (${table.consumedAt} >= ${table.createdAt} AND ${table.consumedAt} <= ${table.expiresAt})`,
    ),
  ],
);

export const hostedGitHubPublicationProposals = pgTable(
  "hosted_github_publication_proposal",
  {
    ...hostedGitHubTenantColumns,
    proposalDigest: text("proposal_digest").notNull(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    proposal: jsonb("proposal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "hosted_github_publication_proposal_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.proposalDigest,
      ],
    }),
    uniqueIndex("hosted_github_publication_proposal_idempotency_uidx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.kind,
      table.idempotencyKey,
    ),
    check(
      "hosted_github_publication_proposal_digest_check",
      sql`${table.proposalDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "hosted_github_publication_proposal_idempotency_check",
      sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "hosted_github_publication_proposal_kind_check",
      sql`${table.kind} IN ('fresh-repository', 'draft-pull-request')`,
    ),
    check(
      "hosted_github_publication_proposal_record_check",
      sql`jsonb_typeof(${table.proposal}) = 'object'`,
    ),
  ],
);

export const hostedGitHubPublicationJournals = pgTable(
  "hosted_github_publication_journal",
  {
    ...hostedGitHubTenantColumns,
    proposalDigest: text("proposal_digest").notNull(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    status: text("status").notNull(),
    record: jsonb("record").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "hosted_github_publication_journal_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.proposalDigest,
      ],
    }),
    uniqueIndex("hosted_github_publication_journal_idempotency_uidx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.idempotencyKey,
    ),
    index("hosted_github_publication_journal_status_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.status,
      table.updatedAt,
    ),
    check(
      "hosted_github_publication_journal_proposal_digest_check",
      sql`${table.proposalDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "hosted_github_publication_journal_receipt_digest_check",
      sql`${table.receiptDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "hosted_github_publication_journal_idempotency_check",
      sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "hosted_github_publication_journal_kind_check",
      sql`${table.kind} IN ('fresh-repository', 'draft-pull-request')`,
    ),
    check(
      "hosted_github_publication_journal_status_check",
      sql`${table.status} IN ('pending', 'failed', 'succeeded')`,
    ),
    check(
      "hosted_github_publication_journal_record_check",
      sql`jsonb_typeof(${table.record}) = 'object'`,
    ),
    check(
      "hosted_github_publication_journal_timestamp_check",
      sql`${table.createdAt} <= ${table.updatedAt}`,
    ),
  ],
);
