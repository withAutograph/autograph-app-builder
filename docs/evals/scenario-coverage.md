# Cross-eval scenario coverage

The [scenario inventory](../../evals/scenario-inventory.json) selects 39 deterministic cases, five Vercel Sandbox integration cases, and one retired internal diagnostic. The inventory test fails when an Eve scenario is missing or duplicated. Do not add tag exclusions that silently remove selected cases.

## Run the supported groups

Run `mise run test:agent` for all deterministic cases and the existing product unit/browser checks. The required general, fresh-bootstrap, and product-quality CI lanes use this same inventory. Mock-model success establishes only those scenario contracts.

Run the opt-in integration group with an existing Arrusted checkout:

```sh
mise run test:sandbox-evals -- /absolute/path/to/arrusted
```

Append one or more inventory names to run a focused repair, for example `sandbox-toolchain` or `design-guidance`. This uses the existing linked Vercel project and managed Development OIDC lifecycle. The task resolves mise-managed executables before crossing the trusted launcher, whose PATH is intentionally restricted. Missing or expired credentials use the existing `local:ensure-oidc` flow; unavailable project access remains a blocker. No static provider keys, new runners, or eval hosting are used.

The shared development environment binding, source preparation, toolchain setup, installation, planning, and application workflow perform the actual work. Networking remains allow-all. The five cases are toolchain inspection, design preview, identity/planning, reviewed changes, and existing-app iteration. They use synthetic data and no publication.

The shared Sandbox setup installs the native compiler needed by Arrusted’s Rust schema validation before preparing dependencies. It selects the available package manager (`apt-get` with `build-essential`, or `dnf` with `gcc`) and verifies `cc`; an installation failure remains a setup failure. This belongs to ordinary Builder setup, not an eval-specific preflight. Vercel’s [current image guidance](https://vercel.com/changelog/run-docker-containers-inside-vercel-sandbox) distinguishes the Ubuntu default from older Amazon Linux runtimes.

Design observation uses the completed `record_ui_preview` HTML produced by the real Sandbox compiler. An installed Playwright browser observes that output and checks a specific interaction outcome. Browser executable resolution happens before Eve isolates HOME. Use the existing `mise run storybook:install-browser` task if the browser is not installed.

## Evidence and comparisons

Eve writes raw results under `.eve/evals/<run>/summary.json`. Retain interrupted attempts and failed assertions as well as successful reruns. The checked-in [frozen audit](../../evals/baselines/cross-eval-2026-09-14.json) is comparison input, not current success evidence.

```sh
mise run eval:cross-eval-report -- \
  --summary /absolute/path/to/summary.json \
  --source-revision COMMIT_SHA \
  --output-dir /absolute/path/outside/the/repository
```

Repeat `--summary` in chronological order. Each attempt remains visible; the last supplied result is selected for the current assessment. Annotate copied summary JSON with `sourceRevision`, `command`, and `evidencePath` when attempts use different revisions. Revisions are explicit declarations, not inferred from Eve output. The report produces HTML, Markdown, and JSON outside the source tree and tracks the seven previously demonstrated improvements separately.

Optional `--supplemental` accepts `{ "scenarios": [{ "id": "...", "status": "blocked", "reason": "...", "evidence": ["..."] }] }`. Use this to explain observed infrastructure blockers or product findings. It cannot promote missing, errored, skipped, empty, or failing runner evidence to success. Raw runner results remain separate. Keep credential-bearing logs and private preview URLs out of shared evidence.

## Avoid changing the benchmark's meaning

These are integration checks, not autonomous self-reproduction. The next live self-reproduction milestone must submit the product brief through the supported public entrypoint and answer only ordinary product questions and approvals. Do not drive its internal stages or use probes as generation evidence.

Trace the active production caller before repairing setup and test that caller. Unused helper tests and infrastructure probes do not establish that the normal workflow performs the operation. Metadata-only planning preparation must remain metadata-only; approved apply owns its dependency installation.

Keep evaluator code observational. Repair missing product automation in the shared Builder workflow. Never manually repair generated output or add eval-only success behavior to product rendering. Assert durable effects and state, not incidental sentences or a list of internal stages that normal automation may combine. Eve assertions on `t` inspect the complete run; use returned turn assertions when testing approval or dispatch behavior for one request.

Keep retired image/cache diagnostics distinct from actual command execution. Missing functionality fails, unavailable infrastructure blocks, and unexecuted behavior remains unassessed. Advisory visual scores do not authorize palette changes or an aggregate passing threshold. See [the repair ledger](other-eval-followups.md) for milestone closure evidence.
