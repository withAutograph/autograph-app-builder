# Autograph App Builder: production publication plan

## Recommendation

Use a public Git-backed Autograph marketplace, hosted in the existing
`withAutograph/autograph-app-builder` repository (or, if the team wants a
catalog independent of the product repository, a separate public
`withAutograph/codex-plugins` repository). Do not make users download or unpack
the release tarball. Codex can clone/track a Git marketplace and install the
plugin from its catalog with `codex plugin add`.

This is the correct first production path because it is immediately supported
by the installed Codex CLI (`codex-cli 0.150.1`), gives the team control over
reviews and releases, and does not require OpenAI approval. It is distinct from
OpenAI's universal public directory, which requires a separate submission and
review.

## Evidence

- [OpenAI plugin packaging and marketplace documentation](https://developers.openai.com/plugins/build/plugins)
  defines `.codex-plugin/plugin.json` as the required manifest, supports
  GitHub shorthand/Git URLs, `--ref`, sparse checkout, Git-backed entries, and
  `codex plugin marketplace add/list/upgrade/remove`.
- [Codex plugin documentation](https://learn.chatgpt.com/docs/plugins) says the
  CLI installs from a configured marketplace, groups entries by marketplace,
  and requires a new session after installation. It also distinguishes repo or
  team marketplaces from the universal directory.
- [OpenAI submission documentation](https://developers.openai.com/plugins/deploy/submission)
  says public-directory publication is: submit, OpenAI review, approval, then
  developer-initiated publication. Approval does not publish automatically.
- Local CLI verification on 2026-08-27: `codex-cli 0.150.1` exposes
  `plugin marketplace add/list/upgrade/remove` and `plugin add`; `marketplace
  add` accepts a local path, `owner/repo[@ref]`, HTTPS Git URL, or SSH URL.
- PR [#67](https://github.com/withAutograph/autograph-app-builder/pull/67) is
  open and mergeable at head `a0aa25f0d9d4a66d5550028c9a5e1bcb9b8753b9`.
  It adds `.codex-plugin/plugin.json`, `.mcp.json`, and a tag-triggered
  release workflow, but currently publishes tarball/receipt/checksum assets;
  it does not add `marketplace.json`.

## Exact repository layout

Prefer this layout in the existing repository:

```text
autograph-app-builder/
├── .agents/plugins/marketplace.json
├── .codex-plugin/plugin.json
├── .mcp.json
├── skills/
├── assets/                         # optional listing assets
├── docs/installing.md
└── .github/workflows/release.yml
```

The catalog should contain one Git-backed entry (paths are relative to the
marketplace root):

```json
{
  "name": "withautograph-codex-plugins",
  "interface": { "displayName": "Autograph Plugins" },
  "plugins": [
    {
      "name": "autograph-app-builder",
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/withAutograph/autograph-app-builder.git",
        "path": "./",
        "ref": "v0.1.0"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
```

If the catalog is moved to a separate repository, use
`./plugins/autograph-app-builder` for `source.path`, and keep the plugin's
`.codex-plugin/plugin.json` at that directory's root. Pin catalog entries to an
immutable release tag or commit SHA; advance the catalog in a reviewed PR.

## Release automation

1. Merge PR #67 only after its checks finish and review the release workflow's
   manifest-version path (it must read `.codex-plugin/plugin.json`, not a
   root-level `plugin.json`).
2. On `vX.Y.Z`, validate the manifest, run the existing deterministic package
   and portable-plugin tests, and build the release receipt/checksum.
3. Create the GitHub release assets as PR #67 does.
4. In the same release PR, update `marketplace.json` from the prior tag to the
   new immutable tag (or use a bot PR generated after the release). Do not
   silently track `main` for production installs.
5. Run `codex plugin marketplace upgrade` and install in a clean test profile;
   verify the installed manifest, exact version, MCP URL, and the five expected
   Eve tools. Treat this as install proof, separate from hosted Eve proof.

The release archive and checksum are useful for audit and fallback, but they
are not part of the normal user installation UX.

## User installation UX

CLI:

```bash
codex plugin marketplace add withAutograph/autograph-app-builder --ref main
codex plugin list
codex plugin add autograph-app-builder@withautograph-codex-plugins
```

For a reproducible production command, document a versioned catalog/ref once
the catalog repository exists, then use `/plugins` in Codex to inspect and
install. Start a new Codex session after installation. The ChatGPT desktop app
can browse the same configured marketplace; the IDE extension is not a plugin
installation surface.

## Distribution choices and required authority

### Public Git-backed marketplace (recommended now)

Requires the GitHub organization owner's approval to make the catalog and plugin
repository public (if not already public), permission to merge the catalog and
release workflow, and production MCP hosting/configuration. No OpenAI catalog
submission is required. Anyone with the public Git URL can configure the
marketplace; this is distribution by explicit source, not universal-directory
listing.

### Organization/workspace distribution

Use a repo marketplace for team/repository distribution, or publish a local
plugin to a ChatGPT workspace when access must stay inside the organization.
Workspace publication requires a workspace admin and selected workspace roles;
it is not public and does not place the plugin in the universal directory.
Confirm workspace policy permits plugin sharing and define the allowed roles.

### OpenAI universal public directory

This is an additional channel, not a replacement for the Git marketplace.
Submit at `https://platform.openai.com/plugins` only after the team approves it.
Prerequisites include a verified developer/business identity, Apps Management
write access, public production MCP URL, domain verification, accurate tool
annotations, public website/support/privacy/terms URLs, production listing
metadata, reviewer credentials without MFA/private-network dependencies, and
five positive plus three negative test cases. OpenAI reviews; only after
approval does the publisher choose to publish. Published MCP metadata and
imported skill snapshots are reviewed versions, so later changes require a new
version submission.

## Security and visibility gates

- Make only the intended repository/catalog public; audit history, secrets,
  release assets, CI logs, and generated files before visibility change.
- Keep `.codex-plugin/plugin.json` as the source manifest. Keep `.app.json` and
  `.mcp.json` mappings explicit and reviewable; never embed credentials.
- Use HTTPS for production MCP, domain verification where submitting to
  OpenAI, least-privilege authentication, and tool annotations matching real
  behavior (`readOnlyHint`, `openWorldHint`, `destructiveHint`).
- Document the Eve-only boundary and fail-closed behavior in the listing and
  skill instructions; do not imply that offline package discovery proves a
  live hosted connection.
- Pin production marketplace entries to tags/SHAs, require protected-branch
  review, and retain checksums/release receipts for rollback and audit.

## Decision required before publication

Approve (a) public visibility of the chosen Git repository, (b) whether the
catalog lives in this repository or a separate `withAutograph` repository, (c)
the first release tag, and (d) whether to submit separately to OpenAI's public
directory. Until those approvals, do not create/alter repositories, change
visibility, publish a package, modify PR #67, or submit the plugin.


