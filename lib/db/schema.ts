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
  (table) => [
    uniqueIndex("user_email_uidx").on(table.email),
    uniqueIndex("user_email_lower_uidx").on(sql`lower(${table.email})`),
  ],
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

export const personalWorkspace = pgTable(
  "personal_workspace",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("personal_workspace_organization_id_uidx").on(
      table.organizationId,
    ),
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

export const passkey = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    aaguid: text("aaguid"),
  },
  (table) => [
    uniqueIndex("passkey_credential_id_uidx").on(table.credentialID),
    index("passkey_user_id_idx").on(table.userId),
  ],
);

export const passkeyOnboarding = pgTable(
  "passkey_onboarding",
  {
    id: text("id").primaryKey(),
    tokenDigest: text("token_digest").notNull(),
    deploymentId: text("deployment_id").notNull(),
    origin: text("origin").notNull(),
    rpId: text("rp_id").notNull(),
    userHandle: text("user_handle").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("passkey_onboarding_token_digest_uidx").on(table.tokenDigest),
    uniqueIndex("passkey_onboarding_user_handle_uidx").on(table.userHandle),
    index("passkey_onboarding_expires_at_idx").on(table.expiresAt),
  ],
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
    adapterGeneration: integer("adapter_generation"),
    title: text("title"),
    stage: text("stage"),
    resumabilityState: text("resumability_state"),
    checkpointDigest: text("checkpoint_digest"),
    checkpointProgressDigest: text("checkpoint_progress_digest"),
    parentSessionId: text("parent_session_id"),
    lastProgressAt: timestamp("last_progress_at", { withTimezone: true }),
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
    index("agent_session_recent_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt.desc(),
      table.sessionId.desc(),
    ),
    uniqueIndex("agent_session_adapter_id_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.adapterSessionId,
    ),
    check(
      "agent_session_adapter_generation_check",
      sql`${table.adapterGeneration} IS NULL OR ${table.adapterGeneration} > 0`,
    ),
    check(
      "agent_session_stage_check",
      sql`${table.stage} IS NULL OR ${table.stage} IN ('starting', 'designing', 'prototype', 'planning', 'ready', 'complete', 'needs_attention')`,
    ),
    check(
      "agent_session_resumability_check",
      sql`${table.resumabilityState} IS NULL OR ${table.resumabilityState} IN ('live', 'checkpoint', 'restart_required', 'terminal')`,
    ),
    check(
      "agent_session_checkpoint_digest_check",
      sql`${table.checkpointDigest} IS NULL OR ${table.checkpointDigest} ~ '^sha256:[a-f0-9]{64}$'`,
    ),
    check(
      "agent_session_checkpoint_progress_digest_check",
      sql`${table.checkpointProgressDigest} IS NULL OR ${table.checkpointProgressDigest} ~ '^sha256:[a-f0-9]{64}$'`,
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
    uniqueIndex("hosted_github_installation_binding_id_tenant_uidx").on(
      table.installationId,
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
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

export const hostedGitHubUserCredentials = pgTable(
  "hosted_github_user_credential",
  {
    ...hostedGitHubTenantColumns,
    providerUserId: text("provider_user_id").notNull(),
    providerLogin: text("provider_login").notNull(),
    encryptedCredential: text("encrypted_credential").notNull(),
    credentialIv: text("credential_iv").notNull(),
    credentialTag: text("credential_tag").notNull(),
    keyVersion: text("key_version").notNull(),
    revision: integer("revision").notNull().default(1),
    active: boolean("active").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "hosted_github_user_credential_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.providerUserId,
      ],
    }),
    check(
      "hosted_github_user_credential_provider_user_id_check",
      sql`${table.providerUserId} ~ '^[1-9][0-9]*$'`,
    ),
    check(
      "hosted_github_user_credential_revision_check",
      sql`${table.revision} > 0`,
    ),
  ],
);

export const builderProvisioningJournals = pgTable(
  "builder_provisioning_journal",
  {
    ...hostedGitHubTenantColumns,
    requestId: text("request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    state: text("state").notNull(),
    revision: integer("revision").notNull().default(1),
    record: jsonb("record").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "builder_provisioning_journal_pk",
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.requestId,
      ],
    }),
    index("builder_provisioning_journal_retention_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt,
    ),
    check(
      "builder_provisioning_journal_request_id_check",
      sql`${table.requestId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "builder_provisioning_journal_request_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "builder_provisioning_journal_state_check",
      sql`${table.state} IN ('pending', 'settled')`,
    ),
    check(
      "builder_provisioning_journal_revision_check",
      sql`${table.revision} > 0`,
    ),
    check(
      "builder_provisioning_journal_record_check",
      sql`jsonb_typeof(${table.record}) = 'object'`,
    ),
  ],
);

export const builderHandoffs = pgTable(
  "builder_handoff",
  {
    handoffId: text("handoff_id").primaryKey(),
    ...hostedGitHubTenantColumns,
    creationRequestId: text("creation_request_id").notNull(),
    requestDigest: text("request_digest").notNull(),
    intent: jsonb("intent").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    sessionId: text("session_id"),
  },
  (table) => [
    uniqueIndex("builder_handoff_creation_uidx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.creationRequestId,
    ),
    index("builder_handoff_expiry_idx").on(table.expiresAt),
    check(
      "builder_handoff_id_check",
      sql`${table.handoffId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "builder_handoff_creation_request_id_check",
      sql`${table.creationRequestId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "builder_handoff_request_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "builder_handoff_intent_check",
      sql`jsonb_typeof(${table.intent}) = 'object'`,
    ),
    check(
      "builder_handoff_time_check",
      sql`${table.createdAt} < ${table.expiresAt}`,
    ),
    check(
      "builder_handoff_redemption_check",
      sql`(${table.redeemedAt} IS NULL AND ${table.sessionId} IS NULL) OR (${table.redeemedAt} BETWEEN ${table.createdAt} AND ${table.expiresAt} AND ${table.sessionId} IS NOT NULL)`,
    ),
  ],
);

export const vercelInstallationAuthorizationStates = pgTable(
  "vercel_installation_authorization_state",
  {
    stateDigest: text("state_digest").primaryKey(),
    ...hostedGitHubTenantColumns,
    authorityDigest: text("authority_digest").notNull(),
    returnTo: text("return_to").notNull().default("/"),
    resumeKey: text("resume_key"),
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
    returnTo: text("return_to").notNull().default("/"),
    resumeKey: text("resume_key"),
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

/**
 * One-time bridge from the existing GitHub installation callback back to the
 * exact Eve authorization callback that parked a repository-access tool call.
 * The public continuation id is stored only as a SHA-256 digest.
 */
export const githubRepositoryAccessContinuations = pgTable(
  "github_repository_access_continuation",
  {
    continuationDigest: text("continuation_digest").primaryKey(),
    ...hostedGitHubTenantColumns,
    sessionId: text("session_id").notNull(),
    requestId: text("request_id").notNull(),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    selectedInstallationId: text("selected_installation_id"),
    callbackUrl: text("callback_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    index("github_repository_access_continuation_expiry_idx").on(
      table.expiresAt,
    ),
    check(
      "github_repository_access_continuation_digest_check",
      sql`${table.continuationDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "github_repository_access_continuation_session_check",
      sql`length(${table.sessionId}) BETWEEN 1 AND 255`,
    ),
    check(
      "github_repository_access_continuation_request_check",
      sql`length(${table.requestId}) BETWEEN 1 AND 255`,
    ),
    check(
      "github_repository_access_continuation_repository_check",
      sql`length(${table.repositoryOwner}) BETWEEN 1 AND 100 AND length(${table.repositoryName}) BETWEEN 1 AND 100`,
    ),
    check(
      "github_repository_access_continuation_installation_check",
      sql`${table.selectedInstallationId} IS NULL OR ${table.selectedInstallationId} ~ '^[1-9][0-9]*$'`,
    ),
    check(
      "github_repository_access_continuation_time_check",
      sql`${table.createdAt} < ${table.expiresAt}`,
    ),
    check(
      "github_repository_access_continuation_authorized_check",
      sql`${table.authorizedAt} IS NULL OR (${table.authorizedAt} >= ${table.createdAt} AND ${table.authorizedAt} <= ${table.expiresAt})`,
    ),
    check(
      "github_repository_access_continuation_consumed_check",
      sql`${table.consumedAt} IS NULL OR (${table.authorizedAt} IS NOT NULL AND ${table.consumedAt} >= ${table.authorizedAt})`,
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

export const emulatePreviewState = pgTable(
  "emulate_preview_state",
  {
    namespace: text("namespace").primaryKey(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "emulate_preview_state_namespace_check",
      sql`length(${table.namespace}) BETWEEN 3 AND 1024`,
    ),
    check(
      "emulate_preview_state_state_check",
      sql`octet_length(${table.state}) BETWEEN 2 AND 8388608`,
    ),
    check(
      "emulate_preview_state_timestamp_check",
      sql`${table.createdAt} <= ${table.updatedAt}`,
    ),
  ],
);
