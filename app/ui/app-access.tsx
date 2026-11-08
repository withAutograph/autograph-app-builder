"use client";

import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import type { AppAccessActionInput, AppAccessActionState } from "@/lib/app-access/action";
import {
  appAccessApiPath,
  appAccessFailureSchema,
  appAccessPath,
  appAccessSnapshotSchema,
} from "@/lib/app-access/contracts";
import type {
  AppAccessAction,
  AppAccessIntent,
  AppAccessSnapshot,
} from "@/lib/app-access/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ActionHandler = (intent: AppAccessIntent) => void;

type ContinueAction = (
  previous: AppAccessActionState | undefined,
  input: AppAccessActionInput,
) => Promise<AppAccessActionState>;

const submitAppAccess = async (
  action: ContinueAction,
  previous: AppAccessActionState | undefined,
  input: AppAccessActionInput,
): Promise<AppAccessActionState> => {
  try {
    return await action(previous, input);
  } catch {
    // A lost Server Action response cannot establish whether the server changed access.
    return {
      status: "error",
      code: "app_access_unknown",
      uncertain: true,
      message: "Builder couldn’t confirm this update. Retry to check the same request.",
    };
  }
};

const invitationStatus = (
  invitation: AppAccessSnapshot["invitations"][number],
  now: number,
): string => {
  if (invitation.status === "expired" || Date.parse(invitation.expiresAt) <= now) {
    return "Expired";
  }
  const labels = {
    unknown: "Delivery unconfirmed",
    ready: "Ready to send",
    sending: "Sending invitation…",
    sent: "Waiting for them to sign in",
  };
  return labels[invitation.deliveryStatus ?? "sent"];
};

const RoleChoices = ({
  options,
  selected,
  onChange,
  disabled,
}: {
  options: AppAccessSnapshot["roles"];
  selected: string[];
  onChange: (roles: string[]) => void;
  disabled: boolean;
}) => {
  const id = useId();
  const selectedRoles = new Set(selected);
  if (options.length === 0) {
    return null;
  }
  return (
    <fieldset disabled={disabled} className="flex flex-wrap gap-4">
      <legend className="mb-2 text-sm font-medium">App role</legend>
      {options.map((role) => (
        <label
          key={role.id}
          htmlFor={`${id}-${role.id}`}
          className="flex items-center gap-2 text-sm"
        >
          <input
            id={`${id}-${role.id}`}
            type="checkbox"
            checked={selectedRoles.has(role.id)}
            onChange={(event) => {
              onChange(
                event.target.checked
                  ? [...selected, role.id]
                  : selected.filter((candidate) => candidate !== role.id),
              );
            }}
          />
          {role.label}
        </label>
      ))}
    </fieldset>
  );
};

const MemberAccess = ({
  member,
  options,
  disabled,
  canManage,
  onAction,
}: {
  member: AppAccessSnapshot["members"][number];
  options: AppAccessSnapshot["roles"];
  disabled: boolean;
  canManage: boolean;
  onAction: ActionHandler;
}) => {
  // This editable draft remounts when the keyed member role assignment changes.
  // oxlint-disable-next-line react-doctor/no-derived-useState -- The parent key includes the saved roles; edits remain local until Save.
  const [roles, setRoles] = useState(member.roles);
  const savedRoles = new Set(member.roles);
  const changed =
    roles.length !== member.roles.length || roles.some((role) => !savedRoles.has(role));
  return (
    <li className="space-y-3 border-b py-4 last:border-b-0">
      <div>
        <p className="font-medium">{member.name || member.email}</p>
        {member.name ? <p className="text-sm text-muted-foreground">{member.email}</p> : null}
      </div>
      {canManage ? (
        <>
          <RoleChoices options={options} selected={roles} onChange={setRoles} disabled={disabled} />
          <div className="flex flex-wrap gap-2">
            {options.length > 0 ? (
              <Button
                variant="outline"
                disabled={disabled || !changed || roles.length === 0}
                onClick={() => {
                  onAction({ action: "change-role", memberId: member.id, roles });
                }}
              >
                Save roles
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => {
                onAction({ action: "remove", memberId: member.id });
              }}
            >
              Remove app access
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {member.roles
            .map((id) => options.find((role) => role.id === id)?.label ?? id)
            .join(", ") || "App access"}
        </p>
      )}
    </li>
  );
};

const InviteForm = ({
  roles,
  disabled,
  onAction,
}: {
  roles: AppAccessSnapshot["roles"];
  disabled: boolean;
  onAction: ActionHandler;
}) => {
  const [email, setEmail] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const emailId = useId();
  return (
    <form
      className="space-y-4 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onAction({ action: "invite", email: email.trim(), roles: selected });
      }}
    >
      <div className="space-y-2">
        <label htmlFor={emailId} className="text-sm font-medium">
          Invite someone
        </label>
        <Input
          id={emailId}
          type="email"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          disabled={disabled}
          placeholder="name@example.com"
          autoComplete="email"
        />
      </div>
      <RoleChoices options={roles} selected={selected} onChange={setSelected} disabled={disabled} />
      <p className="text-sm text-muted-foreground">
        They’ll receive an invitation to this app. Builder will set up their access when they sign
        in.
      </p>
      <Button
        type="submit"
        disabled={disabled || !email.trim() || (roles.length > 0 && selected.length === 0)}
      >
        Send invitation
      </Button>
    </form>
  );
};

const CreatorAccountForm = ({
  email,
  disabled,
  onAction,
}: {
  email: string | undefined;
  disabled: boolean;
  onAction: ActionHandler;
}) => {
  const emailId = useId();
  return (
    <form
      aria-label="Choose your app account"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) {
          return;
        }
        const selected = new FormData(event.currentTarget).get("email");
        // oxlint-disable-next-line typescript/no-base-to-string -- Preserve FormData value coercion before trimming the submitted email.
        onAction({ action: "choose-creator-account", email: String(selected ?? "").trim() });
      }}
    >
      <div className="space-y-2">
        <label htmlFor={emailId} className="text-sm font-medium">
          Email for your app account
        </label>
        <Input
          id={emailId}
          name="email"
          type="email"
          defaultValue={email ?? ""}
          autoComplete="email"
          required
          disabled={disabled}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Use an email you control. Sign in with that account when Builder asks to finish setup.
      </p>
      <Button type="submit" disabled={disabled}>
        Use this email
      </Button>
    </form>
  );
};

const CreatorAccess = ({
  now,
  data,
  disabled,
  onAction,
}: {
  data: AppAccessSnapshot;
  now: number;
  disabled: boolean;
  onAction: ActionHandler;
}) => {
  const { creator } = data;
  const expired = creator.expiresAt !== undefined && Date.parse(creator.expiresAt) <= now;
  const signInUrl = expired ? undefined : creator.signInUrl;
  const hasAppUrl = data.appUrl !== undefined;
  const hasSignInUrl = signInUrl !== undefined;
  const hasRecoveryUrl = creator.recoveryUrl !== undefined;
  const hasCreatorEmail = creator.email !== undefined;
  return (
    <section aria-label="Your app access" className="space-y-3 rounded-lg border p-4">
      {hasCreatorEmail ? (
        <p className="text-sm">
          App account: <span className="font-medium">{creator.email}</span>
        </p>
      ) : null}
      {data.canManage && creator.canChooseAccount === true ? (
        <CreatorAccountForm
          key={creator.email ?? "unselected"}
          email={creator.email}
          disabled={disabled}
          onAction={onAction}
        />
      ) : null}
      {creator.status === "ready" ? (
        <>
          <p role="status">Your access is ready.</p>
          {hasAppUrl ? (
            <a className="underline" href={data.appUrl}>
              Open {data.appName}
            </a>
          ) : null}
        </>
      ) : null}
      {creator.status === "sign_in_required" ? (
        <>
          <h2 className="font-medium">Connect your app account</h2>
          <p className="text-sm text-muted-foreground">
            Sign in or create your app account once. Builder will set up your access and continue
            this saved build automatically.
          </p>
          {hasSignInUrl ? (
            <a className="underline" href={signInUrl} target="_blank" rel="noopener noreferrer">
              Sign in or create account
            </a>
          ) : (
            <>
              <p role="status">Your sign-in link expired. Your app and setup progress are saved.</p>
              <Button
                disabled={disabled}
                onClick={() => {
                  onAction({ action: "renew-sign-in" });
                }}
              >
                Get a new sign-in link
              </Button>
            </>
          )}
          {hasRecoveryUrl ? (
            <p>
              <a
                className="text-sm underline"
                href={creator.recoveryUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Recover your app account
              </a>
            </p>
          ) : null}
        </>
      ) : null}
      {creator.status === "setting_up" ? (
        <p role="status">{creator.message ?? "Setting up your app’s access and data…"}</p>
      ) : null}
      {creator.status === "failed" ? (
        <>
          <p role="alert">
            {creator.message ??
              "Builder couldn’t finish setting up access. Your app and progress are saved."}
          </p>
          {creator.retryable === true ? (
            <Button
              disabled={disabled}
              onClick={() => {
                onAction({ action: "retry-setup" });
              }}
            >
              Retry setup
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
};

export const AppAccessView = ({
  data,
  disabled,
  onAction,
}: {
  data: AppAccessSnapshot;
  disabled: boolean;
  onAction: ActionHandler;
}) => {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
  }, [data]);
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{data.appName}</h1>
        <p className="text-muted-foreground">Access for {data.organizationName}</p>
      </header>
      <CreatorAccess now={now} data={data} disabled={disabled} onAction={onAction} />
      <section aria-labelledby="app-people" className="space-y-4">
        <h2 id="app-people" className="text-xl font-semibold">
          People
        </h2>
        <p className="text-sm text-muted-foreground">
          Access applies to this app. Other apps keep their own permissions.
        </p>
        {data.canManage ? (
          <InviteForm roles={data.roles} disabled={disabled} onAction={onAction} />
        ) : null}
        <ul aria-label="People with app access">
          {data.members.map((member) => (
            <MemberAccess
              key={`${member.id}:${member.roles.join(",")}`}
              member={member}
              options={data.roles}
              disabled={disabled}
              canManage={data.canManage}
              onAction={onAction}
            />
          ))}
        </ul>
        {data.invitations.length > 0 ? (
          <section aria-label="App invitations">
            <h3 className="font-medium">Invitations</h3>
            <ul>
              {data.invitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex flex-wrap items-center justify-between gap-4 border-b py-4 last:border-b-0"
                >
                  <div>
                    <p>{invitation.email}</p>
                    <p className="text-sm text-muted-foreground">
                      {invitationStatus(invitation, now)}
                    </p>
                  </div>
                  {data.canManage ? (
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        disabled={disabled}
                        onClick={() => {
                          onAction({ action: "resend", invitationId: invitation.id });
                        }}
                      >
                        Resend invitation
                      </Button>
                      <Button
                        variant="outline"
                        disabled={disabled}
                        onClick={() => {
                          onAction({ action: "cancel", invitationId: invitation.id });
                        }}
                      >
                        Cancel invitation
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </section>
    </div>
  );
};

export const AppAccessPage = ({
  sessionId,
  continueAction,
}: {
  sessionId: string;
  continueAction: ContinueAction;
}) => {
  const [data, setData] = useState<AppAccessSnapshot>();
  const [notice, setNotice] = useState("");
  const runAction = useCallback(
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
    (previous: AppAccessActionState | undefined, input: AppAccessActionInput) =>
      submitAppAccess(continueAction, previous, input),
    [continueAction],
  );
  // oxlint-disable-next-line unicorn/no-useless-undefined -- React requires the initial state argument; absence means no action has completed.
  const [result, dispatch, pending] = useActionState(runAction, undefined);
  const [retry, setRetry] = useState<AppAccessAction>();
  const [loadingMore, setLoadingMore] = useState(false);
  const active = useRef(false);
  const operation = useRef<AppAccessAction | null>(null);
  const epoch = useRef(0);
  const endpoint = appAccessApiPath(sessionId);

  const readResponse = useCallback(
    async (response: Response) => {
      if (response.status === 401) {
        window.location.assign(
          `/auth/sign-in?callbackURL=${encodeURIComponent(appAccessPath(sessionId))}`,
        );
        throw new Error("Sign in to Builder to manage this app.");
      }
      const body: unknown = await response.json();
      if (!response.ok) {
        const failure = appAccessFailureSchema.safeParse(body);
        throw new Error(
          failure.success
            ? failure.data.message
            : "Builder couldn’t update access. Your app is saved.",
        );
      }
      const next = appAccessSnapshotSchema.parse(body);
      if (next.sessionId !== sessionId) {
        throw new Error("Builder couldn’t load access for this app.");
      }
      return next;
    },
    [sessionId],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (operation.current !== null) {
        return;
      }
      const startedAt = epoch.current;
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal });
        const next = await readResponse(response);
        if (signal?.aborted !== true && !active.current && startedAt === epoch.current) {
          setData(next);
          operation.current = next.pendingCommand ?? null;
          setRetry(next.pendingCommand);
          setNotice(
            next.pendingCommand === undefined
              ? ""
              : "Checking the previous request. Your app and access are saved.",
          );
        }
      } catch {
        if (signal?.aborted !== true && !active.current && startedAt === epoch.current) {
          setNotice(
            "Access status is temporarily unavailable. Your app and setup progress are saved.",
          );
        }
      }
    },
    [endpoint, readResponse],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const onFocus = () => {
      if (document.visibilityState === "visible") {
        void refresh(controller.signal);
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      controller.abort();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    if (data?.creator.status !== "setting_up" && data?.creator.status !== "sign_in_required") {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Inactive effects have no subscription to dispose.
      return undefined;
    }
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !active.current) {
        void refresh(controller.signal);
      }
    }, 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [data?.creator.status, refresh]);

  useEffect(() => {
    if (result === undefined) {
      return;
    }
    active.current = false;
    if (result.status === "ready") {
      setData(result.snapshot);
      operation.current = result.snapshot.pendingCommand ?? null;
      setRetry(result.snapshot.pendingCommand);
      setNotice(
        result.snapshot.pendingCommand === undefined
          ? "App access updated."
          : "Checking the previous request. Your app and access are saved.",
      );
    } else {
      if (!result.uncertain) {
        operation.current = null;
        // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- A confirmed server rejection releases this pending operation, not prop-derived state.
        setRetry(undefined);
      }
      setNotice(result.message);
      if (result.code === "authentication_required") {
        window.location.assign(
          `/auth/sign-in?callbackURL=${encodeURIComponent(appAccessPath(sessionId))}`,
        );
      }
    }
  }, [result, sessionId]);

  const submit = (action: AppAccessAction) => {
    if (active.current) {
      return;
    }
    active.current = true;
    epoch.current += 1;
    setNotice("");
    startTransition(() => {
      dispatch({ sessionId, command: action });
    });
  };
  const onAction: ActionHandler = (intent) => {
    if (retry !== undefined || active.current) {
      return;
    }
    const action = { ...intent, clientRequestId: crypto.randomUUID() };
    setRetry(action);
    operation.current = action;
    submit(action);
  };

  const loadMore = async () => {
    if (data?.nextCursor === undefined || loadingMore) {
      return;
    }
    setLoadingMore(true);
    const startedAt = epoch.current;
    try {
      const response = await fetch(`${endpoint}?cursor=${encodeURIComponent(data.nextCursor)}`, {
        cache: "no-store",
      });
      const next = await readResponse(response);
      if (startedAt !== epoch.current) {
        return;
      }
      setData((previous) =>
        previous === undefined
          ? next
          : {
              ...previous,
              members: [
                ...new Map(
                  [...previous.members, ...next.members].map((member) => [member.id, member]),
                ).values(),
              ],
              invitations: [
                ...new Map(
                  [...previous.invitations, ...next.invitations].map((invitation) => [
                    invitation.id,
                    invitation,
                  ]),
                ).values(),
              ],
              nextCursor: next.nextCursor,
            },
      );
    } catch {
      setNotice(
        "Builder couldn’t load the next people. Your current list is preserved; try again.",
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const hasMore = data?.nextCursor !== undefined;
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-10" aria-busy={pending}>
      <Link className="text-sm underline" href="/">
        Back to Builder
      </Link>
      {notice ? <p role="status">{notice}</p> : null}
      {retry ? (
        <Button
          disabled={pending}
          onClick={() => {
            submit(retry);
          }}
        >
          Retry the same update
        </Button>
      ) : null}
      {data ? (
        <AppAccessView data={data} disabled={pending || retry !== undefined} onAction={onAction} />
      ) : (
        <p role="status">Loading your app’s access…</p>
      )}
      {hasMore ? (
        <Button
          variant="outline"
          disabled={loadingMore || pending}
          onClick={() => {
            void loadMore();
          }}
        >
          {loadingMore ? "Loading people…" : "Show more people"}
        </Button>
      ) : null}
      {!data && notice ? (
        <Button
          onClick={() => {
            void refresh();
          }}
        >
          Try again
        </Button>
      ) : null}
    </main>
  );
};
