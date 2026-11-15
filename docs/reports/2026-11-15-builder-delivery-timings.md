# Builder hosted delivery timings

Recorded November 15, 2026. This report compares one first private release, one
heading-only revision, and one revision that added an optional field. The
historical runs used Socket Label Log. The newer first release and heading
revision used Tool Checkout Notes. The optional-field comparison uses the same
app. Each comparison represents a single observed release in each cohort.

## Publication and deployment

| Case                                | Historical PR                                                            | Measured PR                                                              | Draft to Ready      | Ready to required Check | Ready to merge  | Vercel build    |
| ----------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------- | ----------------------- | --------------- | --------------- |
| First private release               | [#1803](https://github.com/withAutograph/arrusted-development/pull/1803) | [#1834](https://github.com/withAutograph/arrusted-development/pull/1834) | 7m 52s → 6m 11s     | 3m 25s → 3m 49s         | 3m 58s → 4m 07s | 8m 22s → 7m 23s |
| Heading-only revision               | [#1805](https://github.com/withAutograph/arrusted-development/pull/1805) | [#1836](https://github.com/withAutograph/arrusted-development/pull/1836) | 52s → 43s           | 3m 07s → 2m 52s         | 3m 49s → 3m 25s | 8m 13s → 7m 54s |
| Optional Calibration Provider field | [#1824](https://github.com/withAutograph/arrusted-development/pull/1824) | [#1837](https://github.com/withAutograph/arrusted-development/pull/1837) | 5h 03m 51s → 1m 44s | 3m 28s → 3m 28s         | 4m 19s → 4m 19s | 7m 14s → 7m 37s |

The arrows run from historical to measured. Vercel build time ends when the
exact deployment is ready. Alias activation, protected data updates, and
signed-in verification have their own observations. The historical #1824
draft-to-Ready interval includes recovery and coordination. The historical
evidence has no comparable Build-card, private-validation, or schema-settlement
timings. [Timing method](../evals/delivery-reliability.md#delivery-timings)

| Measured release                   | First observed Build card                                                           | Private validation                                                                        | Builder Live                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| New Tool Checkout Notes            | 8m 48s                                                                              | 7m 14s from the first measured command to the first passing run                           | 44m 03s from approval                                                                  |
| Heading-only Tool Checkout Records | 1m 35s                                                                              | 50.8s in the matching hosted validation window                                            | 18m 31s from approval                                                                  |
| Socket Label Log optional field    | 3m 07s from the successful preparation retry, or 2h 12m 56s from the original brief | 1m 31s from the first command to the first passing run. Passing build and test took 22.1s | 28m 52s from the final resume, or 2h 56m 51s from original approval including recovery |

The new-app run took 24m 53s from approval to draft. It recorded six build
checks and four test commands. The heading revision's matching logs showed
one passing build check and one passing test command. Those logs lacked a
direct binding to the release approval. The first optional-field build check
failed, and Builder changed the source before the passing retry. Exact
identical-input repeat counts were unavailable. [New-app Check](https://github.com/withAutograph/arrusted-development/actions/runs/43661857866) ·
[Heading Check](https://github.com/withAutograph/arrusted-development/actions/runs/43733342440) ·
[Optional-field Check](https://github.com/withAutograph/arrusted-development/actions/runs/43745290589)

## Recovery and signed-in acceptance

The recovered Socket session went from a 30s timeout replaying event history to
a completed 107 ms continuation read from a verified checkpoint. Builder then
recovered a stale local schema predecessor by validating in an isolated sandbox
database. The exact Production update reused the original approval. [Checkpoint
fix](https://github.com/withAutograph/autograph-app-builder/pull/1277) ·
[Local validation recovery](https://github.com/withAutograph/autograph-app-builder/pull/1278)

On the optional-field release, Vercel activated its Production alias 81.3s
after the build became ready. Builder then spent 5m 40s in Updating app data
before it reported Live. All ten original rows matched on signed-in reads
during the rollout. After Live, the new field accepted a synthetic value and
all ten original rows and the new value survived a reload at the same URL.
Two follow-up Builder availability reads returned service unavailable after
the Live result. The signed-in save and reload confirmed that the app was
reachable and writable during verification. [Native
deployment](https://vercel.com/autographing/apps/5NdbPzBaNhhXuxq4GxNEX54MgAnG)

A later read reproduced the failure on the same saved session. The Gateway
received the check near the end of Builder’s shared 15-second read budget.
An independent anonymous request returned the expected sign-in redirect, and
the signed-in app still showed all eleven saved rows. Builder now bounds the
optional GitHub history lookup separately so the current app probe gets its
own deadline.

The initial Tool Checkout Notes deployment reached its Production alias, but
the signed-in route failed. A separate repair restored note persistence. The
later heading-only revision reopened the saved note after a signed-in reload
at the same URL. [Initial native
deployment](https://vercel.com/autographing/apps/CwNCCcVU5czDgtwb3zeYxcePYg2r) ·
[Notes repair](https://github.com/withAutograph/arrusted-development/pull/1835) ·
[Heading-only revision](https://github.com/withAutograph/arrusted-development/pull/1836)

## Check selection and remaining deployment time

The measured revisions ran Changes, their app-specific Check and Test, shared
Quality, and the required aggregate Check. They skipped unrelated app,
platform, and Rust suites. The optional-field comparison held Check time at
3m 28s. Selected runner time rose from 6m 39s to 7m 09s. Both runs hit the Bun
dependency cache, missed their app Turbo task cache, and restored the Vercel
build cache. [Historical optional-field
Check](https://github.com/withAutograph/arrusted-development/actions/runs/43630165406) ·
[Measured optional-field Check](https://github.com/withAutograph/arrusted-development/actions/runs/43745290589)

The heading-only Vercel deployment started at least ten Next builds, including
Vendor. Vendor was outside the revision's diff. The sampled provider events
establish a lower bound on that work. [Native build
log](https://vercel.com/autographing/apps/Hb1JBo1SbUxKiNCVzzV7vZe22o8T) ·
[Changed files](https://github.com/withAutograph/arrusted-development/pull/1836/files)
