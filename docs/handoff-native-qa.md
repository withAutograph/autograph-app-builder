# Web-to-native handoff QA with Codex and Computer

Use this runbook for desktop Codex and Cursor acceptance after the automated checks. It is a procedure, not a passing receipt. Record each case as PASS, FAIL, BLOCKED, or NOT RUN; never convert a blocked case into a pass.

## Automated evidence first

Run from the App Builder checkout with the repository-managed mise environment:

```sh
mise run test:unit -- lib/mcp/handoff-oauth.test.ts lib/auth/preview-oauth-real.test.ts lib/handoff/service.test.ts lib/handoff/postgres-store.test.ts lib/agent/prepared-provider-context.test.ts lib/agent/handoff-context.test.ts
mise run test:handoff-e2e
```

The focused task assigns web port 3101, database port 54339, and emulator ports 4100/4101 through mise, avoiding the default suite's ports. It still needs exclusive access to this checkout's ignored test state; do not run both suites in the same checkout at once. The OAuth case also needs port 8787 for a loopback-only test callback receiver, matching Cursor's registered desktop callback. It closes the receiver after each case and fails if the port is occupied; do not stop a real client to free it. This receiver substitutes only for the native callback listener, not code issuance, consent, token exchange, or refresh.

The E2E task owns a disposable local PostgreSQL/emulator environment. Do not point its reset helpers at Preview or Production. If Chromium is missing, use `mise run auth-e2e:setup` once. Do not stop an unrelated server to free a port. The existing `auth-e2e-emulated` CI lane discovers these browser specs; the ordinary unit lane discovers the protocol tests. Do not start competing E2E servers or rerun broad release proofs after each edit.

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| Browser handoff specs | Real local web routes, durable PostgreSQL state, reload/renewal, account isolation, launch/copy fallback | OS launch, native prompt submission, actual MCP redemption when session binding is seeded by a fixture |
| Browser client OAuth spec | Existing browser login through real consent and PKCE token/refresh endpoints, using emulated providers | Native token storage, native refresh behavior, hosted Eve execution |
| `handoff-oauth.test.ts` | Both client identities, actual exchanged JWT verification through the MCP handler, same-session recovery and provider-context forwarding | Native client transport; its engine transport and provider HTTP responses are fixtures |
| Service/store/context tests | Idempotency, lost replies, expiry, restart/recovery, tenant checks, fresh provider access and retry/reconnect classification | An installed desktop client's behavior on Preview |
| Native cases below | Real client installation, browser selection, consent, launch, submission, token continuation and hosted readbacks | Broad repository CI or approval to build/publish/deploy |

Keep raw OAuth callbacks, cookies, codes, tokens, and token-response bodies out of screenshots, traces, videos, HAR files, logs, and test attachments. Sensitive browser specs disable automatic capture. Report sanitized assertions only.

## Local automated receipt — 2026-09-09

- `mise run test:handoff-e2e`: exit 0, all 11 browser cases passed in 1.1 minutes. The Cursor browser case completed real PKCE authorization, JWT owner/workspace verification, refresh-token rotation, and repeat authorization with one consent submission and no repeated provider authorization. GitHub avatar image reads are explicitly excluded from the authorization counter.
- The six focused unit/protocol files listed above: exit 0, 59 tests passed.
- `mise run typecheck`, focused ESLint, formatting, and `git diff --check` passed.
- The development server emitted `The destination stream closed early` during browser navigation; all browser assertions completed successfully.
- These results use local emulated providers and the fixture boundaries above. Native Codex/Cursor acceptance is NOT RUN by this automated pass. This receipt does not replace the earlier Preview receipt or claim that these test changes are deployed.

## Inputs and stop conditions

### Subsequent native preflight (2026-09-09)

Computer successfully opened the user-confirmed `/Applications/Cursor.app`. Its About dialog reported version **3.19.19**. Customize → MCPs showed a Vercel plugin needing authentication, with no Autograph entry in that view. No connection was added or authenticated, and no prompt was submitted. This supersedes the earlier inventory-only uncertainty about Cursor availability; it does not establish a fresh profile or passing OAuth/handoff acceptance. Codex UI control remained blocked by Computer's explicit safety restriction. The user elected to perform the remaining native QA manually after PR creation.

The operator supplies:

- An approved nonproduction canonical origin, deployment ID and source revision. All web, issuer, MCP, and plugin endpoints must refer to that origin.
- An isolated database and approved emulated GitHub/Vercel fixtures, including a selected repository and Vercel team/project accessible by the test user. Resource creation needs its own explicit approval; prefer existing fixtures.
- A browser profile with the test user's Autograph login, and a separate test user/workspace for negative cases. Record aliases, not personal details.
- Fresh native client profiles or a disposable OS test account, with no prior Autograph grant. A new conversation alone is not a fresh client profile. Use a supported isolation mechanism for the installed client version; ask the operator if none is available. Never clear the user's everyday profile.
- The official App Builder plugin built for this Preview origin, and successful dedicated Cursor client setup/readback. A production marketplace package is not a substitute for a Preview-bound package. See [installation](installing.md).

Check native access before the journey: Vercel CLI access with a private header does not prove desktop clients can reach OAuth discovery, the token endpoint, or MCP. If Vercel protection intercepts native requests, mark BLOCKED and ask the operator for an approved compatible test environment/access path. Do not disable protection, add exceptions, embed bypass secrets in client config, or invent a proxy to make acceptance pass.

Use the available **Computer** plugin for UI interaction, reading its current tool instructions first. Discover apps/tabs, act on current visible controls, then inspect the resulting UI before choosing the next action. Do not hard-code coordinates, old element IDs, or client-version-specific menu paths. Read-only operator/API checks may corroborate UI results, but are not native interaction evidence. If a URL/tool policy rejects access, stop that case: do not retry it through another browser, raw CDP, shell UI automation, or another surface.

Computer may prohibit controlling Codex itself. If selecting `com.openai.codex` returns a safety-policy denial, the operator must perform the Codex UI steps manually. Record them as operator-observed, not Computer-executed; do not use another app, browser, or automation API to control the prohibited app indirectly.

Obtain action-time confirmation for new security-sensitive consent where the Computer tool requires it. Hand off password/passkey creation, security-warning overrides, and other human-only actions. Ask before installing missing clients, accepting terms, or modifying an existing profile. Never ask the user to paste provider tokens or connect separate GitHub/Vercel plugins. A build, publication, or deployment request is a separate approval boundary: stop there.

## Native walkthrough

Run N1–N5 with Codex first, then repeat on a separate fresh Cursor profile. Also run N6 in both directions using the same prepared handoff. Keep the browser profile constant between web preparation and client OAuth.

### N1 — Prepare once on the web

1. Open the canonical web origin. Sign into Autograph as test user A normally.
2. Connect the two emulated providers through their actual approval pages. Record one successful connection ceremony per provider. Select the approved repository/installation and Vercel team/project; record sanitized IDs.
3. Prepare an app with a distinctive brief/name. Select the client destination and click **Create App**. Expect the selected client to receive the prepared prompt automatically after preparation; record the handoff ID privately in the QA receipt.
4. Reload `/handoff/[id]`. Expect the same name, brief, selections and preparation status. The explicit launch button is a retry/reopen fallback, not a normal path requirement; expect no **Continued in your app** before submission. If a feature flag hides a required selection, mark that selection case BLOCKED; do not claim it from metadata or toggle unrelated live flags.

### N2 — Install/connect Autograph in the native client

1. Record the app's observed version, OS, and fresh-profile method. Inspect its connection/plugin settings to confirm no existing Autograph connection.
2. **Codex:** follow the page's Codex installation help using the official Preview-bound App Builder plugin. Confirm its endpoint before continuing. Do not replace this with separate provider plugins or a hand-written token.
3. **Cursor:** use **Add Autograph to Cursor** from its installation help. Review the native install dialog: canonical `/mcp`, public client ID `autograph-cursor-desktop`, and no client secret. Do not use cloud/web Cursor.
4. Trigger the client's native OAuth. Observe which browser profile opens. Expect the existing Autograph login to proceed to first-time **Allow Autograph** consent without another GitHub/Vercel authorization ceremony. Confirm only the intended Autograph scopes/recipient. Complete permitted consent and observe the native connection become available.
5. Record the first consent count, provider-authorization counts, and any login required. A different browser profile or expired session is an exception to the normal-path test, not evidence that authenticate-once passed.

Codex supports native CIMD discovery; observe the actual registration method without recording callback queries. Do not force DCR, which this server disables. See [Codex MCP OAuth](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). Cursor's desktop callback is `http://localhost:8787/callback`; see [Cursor MCP](https://cursor.com/docs/mcp).

### N3 — Launch and submit the prepared prompt

1. In the client opened by **Create App**, complete any permitted OS launch confirmation. Expect the selected client with the handoff prompt, not a new provider login or an automatic build. If launch was blocked, use the handoff page's explicit **Open in Codex/Cursor** retry.
2. Review the prompt before submission. It must invoke `autograph_start` with the opaque handoff reference and deterministic request ID; it must not carry provider credentials. Submit explicitly in the native client.
3. Observe the actual Autograph tool response. Record its session ID and status, not merely the assistant's claim of success. A disabled/missing tool or failed response is a failure/blocker, not successful continuation.
4. Return to the browser. Expect **Continued in your app** only after the server has bound that same session. Reload and confirm the binding persists.

[Cursor deeplinks](https://cursor.com/docs/reference/deeplinks) prefill prompts; they require review and confirmation rather than executing automatically.

### N4 — Provider continuity and approval boundary

1. Ask the native agent: “Use Autograph's hosted tools to confirm access to the prepared repository and Vercel team/project. Reuse them; do not create, modify, build, publish, or deploy resources.”
2. Require authenticated readback of the selected GitHub installation/repository and Vercel team/project through Autograph's stored connections. A displayed saved selection or model-generated summary alone is insufficient.
3. Corroborate with sanitized emulator/operator observations: successful provider API reads for the expected IDs and no new OAuth authorization requests or provisioning writes. Do not export authorization headers or raw logs.
4. If hosted tools cannot expose/read back these resources without mutation, mark the readback case BLOCKED. Do not substitute a separate provider plugin. If the agent asks for build/publication approval, stop without approving it.

### N5 — Refresh, restart, recovery, repeat consent

1. Record the access-token lifetime from safe operator configuration (currently five minutes in the contract), not by copying a token. Keep the browser login intact; after expiry plus clock margin, request read-only session/provider status again. Expect success without another provider authorization.
2. Require sanitized evidence of a successful refresh grant, where observable. If only continued UI success is visible, record that result but mark refresh mechanism verification NOT RUN. Never open the native credential store.
3. Quit/reopen the disposable native profile and reopen the handoff. Expect the same session and selected resources. Repeat authenticated provider readbacks.
4. Server restart/recovery requires an operator-controlled nonproduction action and separate approval. After it, repeat session/provider reads; do not claim server recovery from a desktop restart alone.
5. Reconnect the same client using its supported flow without deleting server consent. Expect existing consent reuse where supported; record actual consent screens and cause, rather than silently treating repeated consent as a pass.

### N6 — Duplicate launch and cross-client attachment

1. Open the same handoff in two browser tabs. Submit it twice in one client, then open it in the other client under user A. That other fresh client can need its own first Autograph consent, but not new provider authorization.
2. Verify every successful redemption returns the same session ID. Reload both browser tabs; both must show the same binding and resources.
3. Prepare a second, distinct handoff in another tab. Switching tabs/reloading must not mix app identity or provider selections. Do not equate two distinct handoffs with duplicate redemption of one handoff.

## Failure and fallback cases

Use only approved disposable profiles/fixtures. Operator fault injection is separate from Computer UI actions and must be scoped to this test session.

| Case | Action | Expected observation |
| --- | --- | --- |
| Launch denied | Cancel native OS launch; retry explicitly | Prepared app survives; no false continued status; retry/copy remain usable |
| Clipboard denied | Deny clipboard if supported; use manual-copy field | Prompt remains visible/selectable; no false copied message |
| Expired unredeemed handoff | Operator expires only the fixture; click Renew | Same ID/intent/resource IDs; no new provisioning; launch reenabled |
| Lost redemption reply | Operator drops only the fixture's response after binding; retry | One existing session recovered, not a second session |
| Account/workspace mismatch | Use test user B's native connection on A's handoff | Generic unavailable response and same-account guidance; no owner details; A's session survives |
| Missing browser session | Use a separate disposable browser profile | Login continuation returns to the original handoff/authorization; no silent lost intent |
| Revoked provider access | Operator revokes only fixture access | Reconnect only affected connection; prepared app/session retained; fresh readback after reconnect |
| Provider outage/rate limit | Operator injects a transient emulator error | Retry same session/handoff; no new provider authorization or duplicate resources |
| Partial provisioning | Operator supplies a journal with one successful resource and one failure | Successful resource reused; failure visible; no unapproved retry mutation |

## Receipt template

Create a task-local report; do not overwrite prior receipts. Include no raw OAuth URLs, credentials, personal account details, or credential screenshots.

```text
Date / operator:
Canonical origin / deployment ID / source revision:
Isolated database branch / fixture aliases:
Codex version / fresh-profile method:
Cursor version / fresh-profile method:
Browser version / profile alias / same-browser confirmed:
Plugin endpoint / Cursor registration readiness:
Automated commands / exit codes / counts / fixture boundaries:
Case | client | PASS/FAIL/BLOCKED/NOT RUN | observed result | sanitized evidence
N1...
Handoff/session IDs (private receipt only):
Consent counts per client; provider authorization counts before/after:
Readback IDs and outcomes; refresh/restart/recovery evidence:
Unexpected mutations or approval prompts:
Blockers / next action / owner:
Cleanup performed (only approved test resources):
Conclusion: native support verified / partial / blocked (scope explicitly stated)
```

## Prompt to give Codex with Computer enabled

```text
Use @Computer to run docs/handoff-native-qa.md against the operator-approved
Preview and disposable native profiles. Read the runbook and current Computer
instructions first. Run the automated checks if not already recorded for this
revision, then perform the remaining native UI cases. Preserve the same browser
login for normal-path OAuth. Ask for missing fixture/profile inputs and required
consent/installation approvals. Do not clear everyday profiles, bypass tool or
browser URL policy, weaken Preview protection, expose tokens, install separate
provider plugins, or approve build/publication/deployment. Record observed
versions and PASS/FAIL/BLOCKED/NOT RUN per case in a sanitized local receipt.
Stop blocked cases and continue only independent authorized cases. Do not claim
native support from protocol fixtures, launch requests, or a model summary.
```
