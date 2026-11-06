# Builder-managed app access

The saved build owns access setup and the People view at
`/builds/<sessionId>/access`. The creator signs in or creates an app account once
through the normal identity flow. Builder resumes automatically after verified
identity returns. An existing linked identity does not require another sign-in.
The creator never supplies a database name, connection string or provider key.

The page reads and updates `/api/builder/sessions/<sessionId>/access`. The server
resolves the owner, app, destination and organization from the authenticated
saved session. Public commands name an invitation or member from that app;
browser-provided identity or organization authority is never accepted. App
roles come from the app, including an empty role list for apps without business
roles.

People supports inviting, resending or cancelling an invitation, changing app
roles and removing app access. These operations do not grant access to unrelated
apps or remove a person's global identity. Paginated results are continued using
the server cursor. A failed or interrupted write retains its original request
ID and command; the UI resolves that request before allowing a competing write.
The server returns an unresolved command when the owner reopens the saved app.
Uncertain email delivery is shown as “Delivery unconfirmed”; only an explicit
Resend action authorizes another email.

An expired identity link stays visible with a path to obtain a new link in
Builder. Account recovery is offered through the configured app identity flow.
Returning from sign-in refreshes status automatically; there is no completion
checkbox. The web page and public MCP results expose the same saved-session
access destination. Hosted MCP links use the configured Builder origin, not the
incoming request host.

Setup progress and operational failures are visible separately from delivery.
These controls do not introduce a synthetic runtime, behavior qualification, or
another release approval. Tests exercise identity continuation, scoped actions,
pagination and uncertainty recovery; they are implementation verification, not
requirements imposed on each generated app.
