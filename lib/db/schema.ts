import { sql } from "drizzle-orm";
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

// Better Auth 1.7.1 core + jwt + MCP OAuth Provider schema. These exports use
// the plugin model names intentionally: the Drizzle adapter resolves models by
// object key, while the SQL names remain explicit and stable.
export const user = pgTable(
  "user",
  {
    banExpires: timestamp("ban_expires", { withTimezone: true }),
    banReason: text("ban_reason"),
    banned: boolean("banned").default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    id: text("id").primaryKey(),
    image: text("image"),
    name: text("name").notNull(),
    role: text("role"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("user_email_uidx").on(table.email),
    uniqueIndex("user_email_lower_uidx").on(sql`lower(${table.email})`),
  ]
);

export const session = pgTable(
  "session",
  {
    activeOrganizationId: text("active_organization_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    impersonatedBy: text("impersonated_by"),
    ipAddress: text("ip_address"),
    token: text("token").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("session_token_uidx").on(table.token),
    index("session_user_id_idx").on(table.userId),
  ]
);

export const organization = pgTable(
  "organization",
  {
    audience: text("audience").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    logo: text("logo"),
    metadata: text("metadata"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    uniqueIndex("organization_slug_uidx").on(table.slug),
    uniqueIndex("organization_authority_uidx").on(
      table.issuer,
      table.audience,
      table.workspaceId
    ),
  ]
);

export const member = pgTable(
  "member",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("member_organization_user_uidx").on(
      table.organizationId,
      table.userId
    ),
    index("member_organization_id_idx").on(table.organizationId),
    index("member_user_id_idx").on(table.userId),
  ]
);

export const personalWorkspace = pgTable(
  "personal_workspace",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("personal_workspace_organization_id_uidx").on(
      table.organizationId
    ),
  ]
);

export const invitation = pgTable(
  "invitation",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    email: text("email").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    role: text("role"),
    status: text("status").notNull().default("pending"),
  },
  (table) => [
    index("invitation_organization_id_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ]
);

export const account = pgTable(
  "account",
  {
    accessToken: text("access_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    accountId: text("account_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    idToken: text("id_token"),
    issuer: text("issuer").notNull(),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("account_issuer_account_id_uidx").on(
      table.issuer,
      table.accountId
    ),
    index("account_user_id_idx").on(table.userId),
  ]
);

export const verification = pgTable(
  "verification",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    value: text("value").notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
);

export const passkey = pgTable(
  "passkey",
  {
    aaguid: text("aaguid"),
    backedUp: boolean("backed_up").notNull(),
    counter: integer("counter").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    credentialID: text("credential_id").notNull(),
    deviceType: text("device_type").notNull(),
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    transports: text("transports"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("passkey_credential_id_uidx").on(table.credentialID),
    index("passkey_user_id_idx").on(table.userId),
  ]
);

export const passkeyOnboarding = pgTable(
  "passkey_onboarding",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    deploymentId: text("deployment_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    origin: text("origin").notNull(),
    rpId: text("rp_id").notNull(),
    tokenDigest: text("token_digest").notNull(),
    userHandle: text("user_handle").notNull(),
  },
  (table) => [
    uniqueIndex("passkey_onboarding_token_digest_uidx").on(table.tokenDigest),
    uniqueIndex("passkey_onboarding_user_handle_uidx").on(table.userHandle),
    index("passkey_onboarding_expires_at_idx").on(table.expiresAt),
  ]
);

export const jwks = pgTable("jwks", {
  alg: text("alg"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  crv: text("crv"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  id: text("id").primaryKey(),
  privateKey: text("private_key").notNull(),
  publicKey: text("public_key").notNull(),
});

export const oauthClient = pgTable(
  "oauth_client",
  {
    applicationType: text("application_type"),
    backchannelLogoutSessionRequired: boolean(
      "backchannel_logout_session_required"
    ),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    clientCredentialsScopes: text("client_credentials_scopes")
      .array()
      .default([]),
    clientDiscoveryId: text("client_discovery_id"),
    clientId: text("client_id").notNull(),
    clientSecret: text("client_secret"),
    contacts: text("contacts").array(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    disabled: boolean("disabled").default(false),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    enableEndSession: boolean("enable_end_session"),
    grantTypes: text("grant_types").array(),
    icon: text("icon"),
    id: text("id").primaryKey(),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    metadata: jsonb("metadata"),
    name: text("name"),
    policy: text("policy"),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    redirectUris: text("redirect_uris").array().notNull(),
    referenceId: text("reference_id"),
    requirePKCE: boolean("require_pkce"),
    responseTypes: text("response_types").array(),
    scopes: text("scopes").array(),
    skipConsent: boolean("skip_consent"),
    softwareId: text("software_id"),
    softwareStatement: text("software_statement"),
    softwareVersion: text("software_version"),
    subjectType: text("subject_type"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    tos: text("tos"),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    uri: text("uri"),
    userId: text("user_id").references(() => user.id),
  },
  (table) => [
    uniqueIndex("oauth_client_client_id_uidx").on(table.clientId),
    index("oauth_client_user_id_idx").on(table.userId),
  ]
);

export const oauthResource = pgTable(
  "oauth_resource",
  {
    accessTokenTtl: integer("access_token_ttl"),
    allowedScopes: text("allowed_scopes").array(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    customClaims: jsonb("custom_claims"),
    disabled: boolean("disabled").default(false),
    dpopBoundAccessTokensRequired: boolean(
      "dpop_bound_access_tokens_required"
    ).default(false),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    metadata: jsonb("metadata"),
    name: text("name").notNull(),
    policyVersion: integer("policy_version").default(1),
    refreshTokenTtl: integer("refresh_token_ttl"),
    signingAlgorithm: text("signing_algorithm"),
    signingKeyId: text("signing_key_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("oauth_resource_identifier_uidx").on(table.identifier),
  ]
);

export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }),
    id: text("id").primaryKey(),
    metadata: jsonb("metadata"),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("oauth_client_resource_client_resource_uidx").on(
      table.clientId,
      table.resourceId
    ),
    index("oauth_client_resource_client_id_idx").on(table.clientId),
    index("oauth_client_resource_resource_id_idx").on(table.resourceId),
  ]
);

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    authTime: timestamp("auth_time", { withTimezone: true }),
    authorizationCodeId: text("authorization_code_id"),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId),
    confirmation: jsonb("confirmation"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    id: text("id").primaryKey(),
    referenceId: text("reference_id"),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    resources: text("resources").array(),
    revoked: timestamp("revoked", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    rotationReplayExpiresAt: timestamp("rotation_replay_expires_at", {
      withTimezone: true,
    }),
    rotationReplayResponse: text("rotation_replay_response"),
    scopes: text("scopes").array().notNull(),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    token: text("token").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
  },
  (table) => [
    uniqueIndex("oauth_refresh_token_token_uidx").on(table.token),
    index("oauth_refresh_token_client_id_idx").on(table.clientId),
    index("oauth_refresh_token_session_id_idx").on(table.sessionId),
    index("oauth_refresh_token_user_id_idx").on(table.userId),
    index("oauth_refresh_token_authorization_code_id_idx").on(
      table.authorizationCodeId
    ),
  ]
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    authorizationCodeId: text("authorization_code_id"),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId),
    confirmation: jsonb("confirmation"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    id: text("id").primaryKey(),
    referenceId: text("reference_id"),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    resources: text("resources").array(),
    revoked: timestamp("revoked", { withTimezone: true }),
    scopes: text("scopes").array().notNull(),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    token: text("token"),
    userId: text("user_id").references(() => user.id),
  },
  (table) => [
    uniqueIndex("oauth_access_token_token_uidx").on(table.token),
    index("oauth_access_token_client_id_idx").on(table.clientId),
    index("oauth_access_token_session_id_idx").on(table.sessionId),
    index("oauth_access_token_user_id_idx").on(table.userId),
    index("oauth_access_token_authorization_code_id_idx").on(
      table.authorizationCodeId
    ),
    index("oauth_access_token_refresh_id_idx").on(table.refreshId),
  ]
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId),
    createdAt: timestamp("created_at", { withTimezone: true }),
    id: text("id").primaryKey(),
    referenceId: text("reference_id"),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    resources: text("resources").array(),
    scopes: text("scopes").array().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    userId: text("user_id").references(() => user.id),
  },
  (table) => [
    index("oauth_consent_client_id_idx").on(table.clientId),
    index("oauth_consent_user_id_idx").on(table.userId),
  ]
);

export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  id: text("id").primaryKey(),
});

export const hostedWorkspaceMemberships = pgTable(
  "hosted_workspace_membership",
  {
    active: boolean("active").notNull().default(false),
    audience: text("audience").notNull(),
    issuer: text("issuer").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
      ],
      name: "hosted_workspace_membership_pk",
    }),
  ]
);

export const agentSessions = pgTable(
  "agent_session",
  {
    adapterGeneration: integer("adapter_generation"),
    adapterSessionId: text("adapter_session_id").notNull(),
    audience: text("audience").notNull(),
    checkpointDigest: text("checkpoint_digest"),
    checkpointProgressDigest: text("checkpoint_progress_digest"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    issuer: text("issuer").notNull(),
    lastProgressAt: timestamp("last_progress_at", { withTimezone: true }),
    ownerUserId: text("owner_user_id").notNull(),
    parentSessionId: text("parent_session_id"),
    record: jsonb("record").notNull(),
    resumabilityState: text("resumability_state"),
    sessionId: text("session_id").notNull(),
    stage: text("stage"),
    title: text("title"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.sessionId,
      ],
      name: "agent_session_tenant_pk",
    }),
    index("agent_session_owner_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId
    ),
    index("agent_session_retention_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt
    ),
    index("agent_session_recent_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt.desc(),
      table.sessionId.desc()
    ),
    uniqueIndex("agent_session_adapter_id_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.adapterSessionId
    ),
    check(
      "agent_session_adapter_generation_check",
      sql`${table.adapterGeneration} IS NULL OR ${table.adapterGeneration} > 0`
    ),
    check(
      "agent_session_stage_check",
      sql`${table.stage} IS NULL OR ${table.stage} IN ('starting', 'designing', 'prototype', 'planning', 'ready', 'complete', 'needs_attention')`
    ),
    check(
      "agent_session_resumability_check",
      sql`${table.resumabilityState} IS NULL OR ${table.resumabilityState} IN ('live', 'checkpoint', 'restart_required', 'terminal')`
    ),
    check(
      "agent_session_checkpoint_digest_check",
      sql`${table.checkpointDigest} IS NULL OR ${table.checkpointDigest} ~ '^sha256:[a-f0-9]{64}$'`
    ),
    check(
      "agent_session_checkpoint_progress_digest_check",
      sql`${table.checkpointProgressDigest} IS NULL OR ${table.checkpointProgressDigest} ~ '^sha256:[a-f0-9]{64}$'`
    ),
  ]
);

export const agentOperations = pgTable(
  "agent_operation",
  {
    audience: text("audience").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    issuer: text("issuer").notNull(),
    kind: text("kind").notNull(),
    operationId: text("operation_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    record: jsonb("record").notNull(),
    requestDigest: text("request_digest").notNull(),
    sessionId: text("session_id"),
    state: text("state").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.operationId,
      ],
      name: "agent_operation_tenant_pk",
    }),
    uniqueIndex("agent_operation_idempotency_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.kind,
      table.clientRequestId
    ),
    index("agent_operation_retention_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt,
      table.state
    ),
  ]
);

export const sandboxExecutionLeases = pgTable(
  "sandbox_execution_lease",
  {
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    adapterSessionId: text("adapter_session_id").notNull(),
    audience: text("audience").notNull(),
    epoch: integer("epoch").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
    issuer: text("issuer").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    policyDigest: text("policy_digest").notNull(),
    providerSandboxId: text("provider_sandbox_id").notNull(),
    record: jsonb("record").notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    state: text("state").notNull(),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.adapterSessionId,
      ],
      name: "sandbox_execution_lease_tenant_pk",
    }),
    index("sandbox_execution_lease_workspace_active_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.state,
      table.expiresAt
    ),
    index("sandbox_execution_lease_subject_active_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.state,
      table.expiresAt
    ),
    index("sandbox_execution_lease_orphan_idx").on(
      table.state,
      table.expiresAt
    ),
  ]
);

export const githubPublicationProposals = pgTable(
  "github_publication_proposal",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    proposal: jsonb("proposal").notNull(),
    proposalDigest: text("proposal_digest").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.proposalDigest],
      name: "github_publication_proposal_pk",
    }),
    uniqueIndex("github_publication_proposal_idempotency_idx").on(
      table.kind,
      table.idempotencyKey
    ),
    check(
      "github_publication_proposal_digest_check",
      sql`${table.proposalDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "github_publication_proposal_idempotency_key_check",
      sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "github_publication_proposal_kind_check",
      sql`${table.kind} IN ('fresh-repository', 'draft-pull-request')`
    ),
    check(
      "github_publication_proposal_record_check",
      sql`jsonb_typeof(${table.proposal}) = 'object'`
    ),
  ]
);

export const githubPublicationJournals = pgTable(
  "github_publication_journal",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    proposalDigest: text("proposal_digest").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    record: jsonb("record").notNull(),
    status: text("status").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.proposalDigest],
      name: "github_publication_journal_pk",
    }),
    uniqueIndex("github_publication_journal_idempotency_idx").on(
      table.idempotencyKey
    ),
    index("github_publication_journal_status_idx").on(
      table.status,
      table.updatedAt
    ),
    check(
      "github_publication_journal_proposal_digest_check",
      sql`${table.proposalDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "github_publication_journal_receipt_digest_check",
      sql`${table.receiptDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "github_publication_journal_idempotency_key_check",
      sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "github_publication_journal_kind_check",
      sql`${table.kind} IN ('fresh-repository', 'draft-pull-request')`
    ),
    check(
      "github_publication_journal_status_check",
      sql`${table.status} IN ('pending', 'failed', 'succeeded')`
    ),
    check(
      "github_publication_journal_record_check",
      sql`jsonb_typeof(${table.record}) = 'object'`
    ),
    check(
      "github_publication_journal_timestamp_check",
      sql`${table.createdAt} <= ${table.updatedAt}`
    ),
  ]
);

const hostedGitHubTenantColumns = {
  audience: text("audience").notNull(),
  issuer: text("issuer").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
};

export const hostedGitHubInstallations = pgTable(
  "hosted_github_installation",
  {
    ...hostedGitHubTenantColumns,
    accountId: text("account_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    active: boolean("active").notNull(),
    installationId: text("installation_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
      ],
      name: "hosted_github_installation_pk",
    }),
    uniqueIndex("hosted_github_installation_id_tenant_uidx").on(
      table.installationId,
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId
    ),
    check(
      "hosted_github_installation_id_check",
      sql`${table.installationId} ~ '^[1-9][0-9]*$'`
    ),
    check(
      "hosted_github_installation_account_id_check",
      sql`${table.accountId} ~ '^[1-9][0-9]*$'`
    ),
    check(
      "hosted_github_installation_account_type_check",
      sql`${table.accountType} IN ('Organization', 'User')`
    ),
  ]
);

/** Multi-installation GitHub bindings used by App Builder selection. The
 * original single binding remains the publication-runtime compatibility row;
 * connecting another scope never broadens publication authority implicitly. */
export const hostedGitHubInstallationBindings = pgTable(
  "hosted_github_installation_binding",
  {
    ...hostedGitHubTenantColumns,
    accountId: text("account_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    active: boolean("active").notNull(),
    installationId: text("installation_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.installationId,
      ],
      name: "hosted_github_installation_binding_pk",
    }),
    uniqueIndex("hosted_github_installation_binding_id_tenant_uidx").on(
      table.installationId,
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId
    ),
    check(
      "hosted_github_installation_binding_id_check",
      sql`${table.installationId} ~ '^[1-9][0-9]*$'`
    ),
    check(
      "hosted_github_installation_binding_account_id_check",
      sql`${table.accountId} ~ '^[1-9][0-9]*$'`
    ),
    check(
      "hosted_github_installation_binding_account_type_check",
      sql`${table.accountType} IN ('Organization', 'User')`
    ),
  ]
);

export const hostedVercelInstallations = pgTable(
  "hosted_vercel_installation",
  {
    ...hostedGitHubTenantColumns,
    active: boolean("active").notNull(),
    displayName: text("display_name").notNull(),
    encryptedToken: text("encrypted_token").notNull(),
    installationId: text("installation_id").notNull(),
    plan: text("plan").notNull(),
    scopeId: text("scope_id").notNull(),
    scopeType: text("scope_type").notNull(),
    slug: text("slug").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenKeyVersion: text("token_key_version").notNull(),
    tokenTag: text("token_tag").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.installationId,
      ],
      name: "hosted_vercel_installation_pk",
    }),
    uniqueIndex("hosted_vercel_installation_id_uidx").on(table.installationId),
    check(
      "hosted_vercel_installation_scope_type_check",
      sql`${table.scopeType} IN ('team', 'user')`
    ),
  ]
);

export const hostedGitHubUserCredentials = pgTable(
  "hosted_github_user_credential",
  {
    ...hostedGitHubTenantColumns,
    active: boolean("active").notNull(),
    credentialIv: text("credential_iv").notNull(),
    credentialTag: text("credential_tag").notNull(),
    encryptedCredential: text("encrypted_credential").notNull(),
    keyVersion: text("key_version").notNull(),
    providerLogin: text("provider_login").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    revision: integer("revision").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.providerUserId,
      ],
      name: "hosted_github_user_credential_pk",
    }),
    check(
      "hosted_github_user_credential_provider_user_id_check",
      sql`${table.providerUserId} ~ '^[1-9][0-9]*$'`
    ),
    check(
      "hosted_github_user_credential_revision_check",
      sql`${table.revision} > 0`
    ),
  ]
);

export const builderProvisioningJournals = pgTable(
  "builder_provisioning_journal",
  {
    ...hostedGitHubTenantColumns,
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    record: jsonb("record").notNull(),
    requestDigest: text("request_digest").notNull(),
    requestId: text("request_id").notNull(),
    revision: integer("revision").notNull().default(1),
    state: text("state").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.requestId,
      ],
      name: "builder_provisioning_journal_pk",
    }),
    index("builder_provisioning_journal_retention_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt
    ),
    check(
      "builder_provisioning_journal_request_id_check",
      sql`${table.requestId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`
    ),
    check(
      "builder_provisioning_journal_request_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "builder_provisioning_journal_state_check",
      sql`${table.state} IN ('pending', 'settled')`
    ),
    check(
      "builder_provisioning_journal_revision_check",
      sql`${table.revision} > 0`
    ),
    check(
      "builder_provisioning_journal_record_check",
      sql`jsonb_typeof(${table.record}) = 'object'`
    ),
  ]
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
      table.creationRequestId
    ),
    index("builder_handoff_expiry_idx").on(table.expiresAt),
    check(
      "builder_handoff_id_check",
      sql`${table.handoffId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`
    ),
    check(
      "builder_handoff_creation_request_id_check",
      sql`${table.creationRequestId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`
    ),
    check(
      "builder_handoff_request_digest_check",
      sql`${table.requestDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "builder_handoff_intent_check",
      sql`jsonb_typeof(${table.intent}) = 'object'`
    ),
    check(
      "builder_handoff_time_check",
      sql`${table.createdAt} < ${table.expiresAt}`
    ),
    check(
      "builder_handoff_redemption_check",
      sql`(${table.redeemedAt} IS NULL AND ${table.sessionId} IS NULL) OR (${table.redeemedAt} BETWEEN ${table.createdAt} AND ${table.expiresAt} AND ${table.sessionId} IS NOT NULL)`
    ),
  ]
);

/** Durable, tenant-scoped builder state used to resume across auth/provider redirects. */
export const builderDrafts = pgTable(
  "builder_draft",
  {
    ...hostedGitHubTenantColumns,
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    draftId: text("draft_id").notNull(),
    lastClientMutationId: text("last_client_mutation_id"),
    record: jsonb("record").notNull(),
    revision: integer("revision").notNull().default(1),
    status: text("status").notNull().default("active"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.draftId,
      ],
      name: "builder_draft_pk",
    }),
    index("builder_draft_updated_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt
    ),
    uniqueIndex("builder_draft_active_tenant_uidx")
      .on(table.issuer, table.audience, table.workspaceId, table.ownerUserId)
      .where(sql`${table.status} = 'active'`),
    check("builder_draft_revision_check", sql`${table.revision} > 0`),
    check(
      "builder_draft_status_check",
      sql`${table.status} IN ('active', 'archived')`
    ),
    check(
      "builder_draft_record_check",
      sql`jsonb_typeof(${table.record}) = 'object'`
    ),
    check(
      "builder_draft_last_client_mutation_id_check",
      sql`${table.lastClientMutationId} IS NULL OR ${table.lastClientMutationId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`
    ),
  ]
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
      table.expiresAt
    ),
    check(
      "vercel_installation_authorization_state_digest_check",
      sql`${table.stateDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vercel_installation_authorization_authority_digest_check",
      sql`${table.authorityDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vercel_installation_authorization_state_time_check",
      sql`${table.createdAt} < ${table.expiresAt}`
    ),
    check(
      "vercel_installation_authorization_state_consumed_check",
      sql`${table.consumedAt} IS NULL OR (${table.consumedAt} >= ${table.createdAt} AND ${table.consumedAt} <= ${table.expiresAt})`
    ),
  ]
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
      table.expiresAt
    ),
    check(
      "github_installation_authorization_state_digest_check",
      sql`${table.stateDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "github_installation_authorization_authority_digest_check",
      sql`${table.authorityDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "github_installation_authorization_state_time_check",
      sql`${table.createdAt} < ${table.expiresAt}`
    ),
    check(
      "github_installation_authorization_state_consumed_check",
      sql`${table.consumedAt} IS NULL OR (${table.consumedAt} >= ${table.createdAt} AND ${table.consumedAt} <= ${table.expiresAt})`
    ),
  ]
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
      table.expiresAt
    ),
    check(
      "github_repository_access_continuation_digest_check",
      sql`${table.continuationDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "github_repository_access_continuation_session_check",
      sql`length(${table.sessionId}) BETWEEN 1 AND 255`
    ),
    check(
      "github_repository_access_continuation_request_check",
      sql`length(${table.requestId}) BETWEEN 1 AND 255`
    ),
    check(
      "github_repository_access_continuation_repository_check",
      sql`length(${table.repositoryOwner}) BETWEEN 1 AND 100 AND length(${table.repositoryName}) BETWEEN 1 AND 100`
    ),
    check(
      "github_repository_access_continuation_installation_check",
      sql`${table.selectedInstallationId} IS NULL OR ${table.selectedInstallationId} ~ '^[1-9][0-9]*$'`
    ),
    check(
      "github_repository_access_continuation_time_check",
      sql`${table.createdAt} < ${table.expiresAt}`
    ),
    check(
      "github_repository_access_continuation_authorized_check",
      sql`${table.authorizedAt} IS NULL OR (${table.authorizedAt} >= ${table.createdAt} AND ${table.authorizedAt} <= ${table.expiresAt})`
    ),
    check(
      "github_repository_access_continuation_consumed_check",
      sql`${table.consumedAt} IS NULL OR (${table.authorizedAt} IS NOT NULL AND ${table.consumedAt} >= ${table.authorizedAt})`
    ),
  ]
);

export const hostedGitHubPublicationProposals = pgTable(
  "hosted_github_publication_proposal",
  {
    ...hostedGitHubTenantColumns,
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    proposal: jsonb("proposal").notNull(),
    proposalDigest: text("proposal_digest").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.proposalDigest,
      ],
      name: "hosted_github_publication_proposal_pk",
    }),
    uniqueIndex("hosted_github_publication_proposal_idempotency_uidx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.kind,
      table.idempotencyKey
    ),
    check(
      "hosted_github_publication_proposal_digest_check",
      sql`${table.proposalDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "hosted_github_publication_proposal_idempotency_check",
      sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "hosted_github_publication_proposal_kind_check",
      sql`${table.kind} IN ('fresh-repository', 'draft-pull-request')`
    ),
    check(
      "hosted_github_publication_proposal_record_check",
      sql`jsonb_typeof(${table.proposal}) = 'object'`
    ),
  ]
);

export const hostedGitHubPublicationJournals = pgTable(
  "hosted_github_publication_journal",
  {
    ...hostedGitHubTenantColumns,
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    proposalDigest: text("proposal_digest").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    record: jsonb("record").notNull(),
    status: text("status").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.issuer,
        table.audience,
        table.workspaceId,
        table.ownerUserId,
        table.proposalDigest,
      ],
      name: "hosted_github_publication_journal_pk",
    }),
    uniqueIndex("hosted_github_publication_journal_idempotency_uidx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.idempotencyKey
    ),
    index("hosted_github_publication_journal_status_idx").on(
      table.issuer,
      table.audience,
      table.workspaceId,
      table.ownerUserId,
      table.status,
      table.updatedAt
    ),
    check(
      "hosted_github_publication_journal_proposal_digest_check",
      sql`${table.proposalDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "hosted_github_publication_journal_receipt_digest_check",
      sql`${table.receiptDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "hosted_github_publication_journal_idempotency_check",
      sql`${table.idempotencyKey} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "hosted_github_publication_journal_kind_check",
      sql`${table.kind} IN ('fresh-repository', 'draft-pull-request')`
    ),
    check(
      "hosted_github_publication_journal_status_check",
      sql`${table.status} IN ('pending', 'failed', 'succeeded')`
    ),
    check(
      "hosted_github_publication_journal_record_check",
      sql`jsonb_typeof(${table.record}) = 'object'`
    ),
    check(
      "hosted_github_publication_journal_timestamp_check",
      sql`${table.createdAt} <= ${table.updatedAt}`
    ),
  ]
);

export const emulatePreviewState = pgTable(
  "emulate_preview_state",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    namespace: text("namespace").primaryKey(),
    state: text("state").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "emulate_preview_state_namespace_check",
      sql`length(${table.namespace}) BETWEEN 3 AND 1024`
    ),
    check(
      "emulate_preview_state_state_check",
      sql`octet_length(${table.state}) BETWEEN 2 AND 8388608`
    ),
    check(
      "emulate_preview_state_timestamp_check",
      sql`${table.createdAt} <= ${table.updatedAt}`
    ),
  ]
);
