# Browser verification enters the selected application

A public app URL has an exact origin and a separate application entry path.
BetterAuth origins, callback configuration, and cookies keep that exact origin.
Browser verification must enter the app's actual catalog route rather than
assuming that `/` belongs to it or deriving a prefix from its app ID.

The repository's `app:describe` projects `app.browserEntryPath` from its actual
catalog using the official route matcher. A unique literal route is automatic.
With several entries, the app can declare `autograph.browserEntryPath` in its
package metadata; the full catalog matcher must select that app for the concrete
path. Invalid choices and ambiguity produce `null`. They leave app description,
provisioning, Auth setup, and public release available.

The public runtime binding reads that checked entry beside its independently
verified public release. Prepared execution carries `browserTestEntryPath`
separately from `browserTestBaseUrl`. Only the browser task fails visibly when
its selected public entry is unresolved. It receives `APP_TEST_ENTRY_PATH` and
`APP_TEST_BASE_URL` as distinct values through the existing task runner.

New generated browser smoke tests use `appTestPath()` from
`@autograph/playwright-config/entry-path`. This helper composes app-relative
navigation with the checked entry. Standalone previews without that environment
value preserve their existing navigation. Existing authored browser tests are
not intercepted or rewritten; they opt into the helper where their navigation
is app-relative. A passing test proves its actual asserted scenarios only.
