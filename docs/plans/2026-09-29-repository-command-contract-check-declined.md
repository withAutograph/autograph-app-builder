# Repository command compatibility check — declined

Date: September 29, 2026

Status: Considered and declined. This is a decision record, not planned work.

We considered adding a deterministic Arrusted-to-Builder integration check
covering repository commands, identity results, static and CUE creation,
candidate formatting, validation, existing-app iteration, and portable packages.
The initial proposal included revision pairing and cross-repository CI.

That proposal was declined because it would couple the repositories too closely.
Builder should be able to work with other repositories, rather than depend on
Arrusted specifically. Supporting a restricted command set matching Arrusted's
current commands remains an acceptable scope for Builder today.

We then considered a smaller Builder-owned suite using independent executable
repository fixtures to protect that command/result contract, without paired
revisions or cross-repository CI. This proposal was also declined. No new
contract-test suite or integration harness is planned from this discussion.

This decision leaves the existing workflow and tests in place. It does not
authorize runtime generalization, a new repository manifest, additional
admission checks, or changes to publication and provider approval boundaries.
