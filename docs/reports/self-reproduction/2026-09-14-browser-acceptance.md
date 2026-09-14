# Public recovery delivers a page, but the replica remains incomplete

## Frozen run

- Public session: `wrun_01M2EYE4KJ9MXMME867DJRE1CC`, final cursor 72.
- Builder source: `06bc5de62206bf017670798c567bcf27f6a0fc0d`.
- Existing clean Arrusted checkout: `f992cee2f301c57fe3289a26f26e36b15b683d2f`.
- Input: unchanged checked-in product brief, one ordinary build approval, then
  one ordinary request to recover startup and deliver a private working preview.
- HTTP-ready receipt: 2026-09-14 03:30:14 UTC; expiry 03:40:09 UTC.
- No candidate patches, internal-stage instructions, publication, or provisioning.

PR 438 landed the shared startup ownership repair as
`24030f1404c5fe37cd4f6ea52e5f59c0e6e8cba0`. Its PR and main CI passed. This run
used the identical implementation at its pre-merge source revision.

## Observed results

| Requirement                                  | Result                             | Evidence                                                                                                       |
| -------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Deliver a reachable private app              | Passed within observed window      | Public working-preview receipt and browser HTTP 200                                                            |
| Ordinary startup recovery                    | Passed for page delivery           | Initial attempt failed; ordinary recovery returned the receipt                                                 |
| Brief continuation                           | Failed                             | Valid brief entered by browser filling and typing; Continue remained disabled                                  |
| Example prompt and documentation interaction | Failed                             | Clicking the visible controls produced no state change                                                         |
| Durable server drafts                        | Failed in inspected implementation | Historical generated source stores drafts in browser localStorage                                              |
| Independent child creation                   | Failed in inspected implementation | Creation waits 900 ms then sets local ready state; preview is an in-page article                               |
| Cancellation and retry                       | Failed in inspected implementation | Cancellation does not clear the creation timer; retry repeats simulation                                       |
| Provider connections                         | Failed in inspected implementation | Buttons report unavailable rather than execute a connection flow                                               |
| Global authentication and tenant isolation   | Unassessed                         | Visible sign-in is inert; partial source inspection does not establish global guards                           |
| Paired visual and framework behavior         | Unassessed                         | Candidate-only captures cannot substitute for matching authenticated states or navigation/isolation assertions |

The browser observed the same disabled continuation at 1440×900, 1920×1080,
and 1024×768, with no horizontal overflow. These are diagnostic captures at the
existing desktop sizes, not a visual similarity score. Anonymous-entry work
remains excluded; the failed app-brief continuation prevents access to the
requested workspace.

## Diagnosis and next repairs

1. **Browser startup:** the visible page was inert despite HTTP 200 for scripts,
   no page error, and no CSP error. The first button had no React attachment
   when inspected. WebSocket HMR handshakes returned 502; the shared gateway
   rejected all upgrades. Add authenticated upgrade forwarding for normal dev
   previews. This transport defect is confirmed; its responsibility for the
   inert UI remains a hypothesis until browser behavior proves otherwise.
2. **Executable discovery:** retained tool output confirms `ENOENT` for the
   app-local Next executable. Normal recovery used root-installed Next from the
   app directory and found a working `/` landing route. Validation and preview
   use the same applied checkout; a missing execution overlay was not found.
   Prefer the repository's discovered package command and actual dependency
   failure recovery instead of assuming package-local binary paths.
3. **Backend implementation and validation:** preserve the requested independent
   behavior through implementation and execute write/readback and child-output
   checks. Compilation and app-authored tests passed while these behaviors were
   simulated. More acceptance prose alone does not close this gap.
4. **Repeatable observation:** retain a command that opens the delivered public
   preview, records browser failures and desktop captures, and preserves partial
   results. It must not create a candidate runtime or repair generated code.

The historical source review is not a complete final filesystem export. The
local evidence directory contains the original public transcript, initial
failure snapshot, final assessment in HTML/Markdown/JSON, source excerpts with
provenance, and browser receipts/screenshots. Private continuation state and
bearer links are excluded from this checked-in report. No later repair changes
this frozen result into a successful reproduction.
