"use client";

import {
  parseOAuthAuthorizationRequest,
  resolveOAuthScopeMetadata,
  sanitizeOAuthClientUrl,
} from "@better-auth-ui/core/plugins/oauth-provider";
import type {
  OAuthAuthorizationRequest,
  OAuthScopeMetadataSource,
} from "@better-auth-ui/core/plugins/oauth-provider";
import { useAuthPlugin, useSession } from "@better-auth-ui/react";
import {
  useOAuthConsent,
  usePublicOAuthClient,
} from "@better-auth-ui/react/plugins/oauth-provider";
import { Check, ShieldCheck } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { oauthProviderPlugin } from "@/lib/auth/oauth-provider-plugin";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { UserAvatar } from "../user/user-avatar";

type OAuthLocalization = ReturnType<typeof oauthProviderPlugin>["localization"];
type OAuthSession = Awaited<ReturnType<typeof authClient.getSession>>["data"];
type OAuthClientData = Awaited<ReturnType<typeof authClient.oauth2.publicClient>>["data"];
type OAuthConsentVariables = Parameters<typeof authClient.oauth2.consent>[0];
interface OAuthConsentResult {
  mutate: (variables: OAuthConsentVariables) => void;
  isPending: boolean;
  variables: OAuthConsentVariables | undefined;
}
interface PublicOAuthClient {
  client_uri?: string | null;
  client_name?: string | null;
  logo_uri?: string | null;
  policy_uri?: string | null;
  tos_uri?: string | null;
}

export interface OAuthConsentProps {
  className?: string;
}

const interpolateClient = (template: string, clientName: string) =>
  template.replace("{{client}}", clientName);

const subscribeToLocation = () => () => {
  // The location snapshot does not need a subscription in this flow.
};
const getLocationSearch = () => window.location.search;
const getServerLocationSearch = () => "";
const CONSENT_CARD_CLASS = "w-full max-w-md";

const hasText = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.length > 0;

const isSignedIn = (session: ReturnType<typeof useSession>["data"]): boolean =>
  session !== null && session !== undefined;

const isInvalidRequest = ({
  request,
  session,
  isSessionPending,
  isClientError,
  isClientPending,
  client,
}: {
  request: OAuthAuthorizationRequest | undefined;
  session: unknown;
  isSessionPending: boolean;
  isClientError: boolean;
  isClientPending: boolean;
  client: unknown;
}) => {
  if (request === undefined) {
    return false;
  }
  if (!hasText(request.clientId)) {
    return true;
  }
  if (!isSessionPending && !isSignedIn(session)) {
    return true;
  }
  if (isClientError) {
    return true;
  }
  return !isClientPending && isSignedIn(session) && client === null;
};

const renderRequestedScopes = (
  request: OAuthAuthorizationRequest | undefined,
  scopeMetadata: OAuthScopeMetadataSource | undefined,
) =>
  request === undefined ? (
    <div className="flex gap-3">
      <Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
      <div className="grid flex-1 gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-full max-w-64" />
      </div>
    </div>
  ) : (
    <ul className="grid gap-3">
      {request.scopes.map((scope) => {
        const metadata = resolveOAuthScopeMetadata(scopeMetadata, scope, {
          clientId: request.clientId,
          requestedScopes: request.scopes,
        });
        return (
          <li className="flex gap-3" key={scope}>
            <Check className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="grid gap-0.5">
              <p className="text-sm font-medium">{metadata.label}</p>
              {hasText(metadata.description) ? (
                <p className="text-xs text-muted-foreground">{metadata.description}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );

const renderClientIdentity = (
  client: PublicOAuthClient | null | undefined,
  clientName: string,
  logoUrl: string | null,
) => (
  <div className="flex items-center gap-3">
    {client === undefined ? (
      <Skeleton className="size-10 rounded-full" />
    ) : (
      <Avatar size="lg">
        <AvatarImage alt={clientName} referrerPolicy="no-referrer" src={logoUrl} />
        <AvatarFallback>
          <ShieldCheck className="size-5" />
        </AvatarFallback>
      </Avatar>
    )}
    <div className="min-w-0 flex-1">
      {client === undefined ? (
        <Skeleton className="h-4 w-36" />
      ) : (
        <p className="truncate font-medium">{clientName}</p>
      )}
      {hasText(client?.client_uri) ? (
        <p className="truncate text-xs text-muted-foreground">{client.client_uri}</p>
      ) : null}
    </div>
  </div>
);

const OAuthConsentCard = ({
  className,
  client,
  clientName,
  logoUrl,
  policyUrl,
  termsUrl,
  request,
  session,
  isSessionPending,
  consent,
  canRespond,
  localization,
  scopeMetadata,
}: {
  className?: string;
  client: ReturnType<typeof usePublicOAuthClient>["data"];
  clientName: string;
  logoUrl: string | null;
  policyUrl: string | null;
  termsUrl: string | null;
  request: OAuthAuthorizationRequest | undefined;
  session: OAuthSession;
  isSessionPending: boolean;
  consent: OAuthConsentResult;
  canRespond: boolean;
  localization: OAuthLocalization;
  scopeMetadata: OAuthScopeMetadataSource | undefined;
}) => (
  <Card className={cn(CONSENT_CARD_CLASS, className)}>
    <CardHeader className="gap-4">
      {renderClientIdentity(client, clientName, logoUrl)}
      <div className="grid gap-1">
        <CardTitle className="text-xl">
          {interpolateClient(localization.authorize, clientName)}
        </CardTitle>
        <CardDescription>
          {interpolateClient(localization.authorizationDescription, clientName)}
        </CardDescription>
      </div>
    </CardHeader>
    <CardContent className="flex flex-col gap-5">
      <div className="grid gap-3">
        <p className="text-sm font-medium">
          {interpolateClient(localization.requestedPermissions, clientName)}
        </p>
        {renderRequestedScopes(request, scopeMetadata)}
      </div>
      <Separator />
      <div className="flex items-center gap-3">
        <UserAvatar isPending={isSessionPending} user={session?.user} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{localization.signedInAs}</p>
          {session ? (
            <>
              <p className="truncate text-sm font-medium">
                {hasText(session.user.name) ? session.user.name : session.user.email}
              </p>
              {hasText(session.user.name) ? (
                <p className="truncate text-xs text-muted-foreground">{session.user.email}</p>
              ) : null}
            </>
          ) : (
            <Skeleton className="mt-1 h-4 w-40" />
          )}
        </div>
      </div>
      {policyUrl !== null || termsUrl !== null ? (
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
          {policyUrl === null ? null : (
            <a
              className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
              href={policyUrl}
              rel="noreferrer"
              target="_blank"
            >
              {localization.privacyPolicy}
            </a>
          )}
          {termsUrl === null ? null : (
            <a
              className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
              href={termsUrl}
              rel="noreferrer"
              target="_blank"
            >
              {localization.termsOfService}
            </a>
          )}
        </div>
      ) : null}
    </CardContent>
    <CardFooter className="grid grid-cols-2 gap-2">
      <Button
        disabled={!canRespond}
        variant="outline"
        onClick={() => {
          consent.mutate({ accept: false });
        }}
      >
        {consent.isPending && !consent.variables?.accept ? <Spinner /> : null}
        {localization.cancel}
      </Button>
      <Button
        disabled={!canRespond}
        onClick={() => {
          consent.mutate({ accept: true });
        }}
      >
        {consent.isPending && consent.variables?.accept ? <Spinner /> : null}
        {localization.allow}
      </Button>
    </CardFooter>
  </Card>
);

export const OAuthConsent = ({ className }: OAuthConsentProps) => {
  const plugin = useAuthPlugin(oauthProviderPlugin);
  const { localization, scopeMetadata } = plugin;
  const sessionResult = useSession(authClient);
  const session = sessionResult.data as OAuthSession;
  const isSessionPending = sessionResult.isPending;
  const locationSearch = useSyncExternalStore(
    subscribeToLocation,
    getLocationSearch,
    getServerLocationSearch,
  );
  const request: OAuthAuthorizationRequest | undefined = hasText(locationSearch)
    ? parseOAuthAuthorizationRequest(locationSearch)
    : undefined;

  const publicClient = usePublicOAuthClient(authClient, request?.clientId, {
    enabled: isSignedIn(session) && hasText(request?.clientId),
  });
  const consentResult = useOAuthConsent(authClient);
  const consent: OAuthConsentResult = consentResult;
  const client = publicClient.data as OAuthClientData;
  const clientName = hasText(client?.client_name) ? client.client_name : localization.application;
  const logoUrl = sanitizeOAuthClientUrl(client?.logo_uri);
  const policyUrl = sanitizeOAuthClientUrl(client?.policy_uri);
  const termsUrl = sanitizeOAuthClientUrl(client?.tos_uri);
  const invalidRequest = isInvalidRequest({
    client,
    isClientError: publicClient.isError,
    isClientPending: publicClient.isPending,
    isSessionPending,
    request,
    session,
  });
  const canRespond =
    hasText(request?.clientId) && isSignedIn(session) && client !== undefined && !consent.isPending;

  if (invalidRequest) {
    return (
      <Card className={cn(CONSENT_CARD_CLASS, className)}>
        <CardHeader>
          <CardTitle className="text-xl">{localization.invalidRequest}</CardTitle>
          <CardDescription>{localization.invalidRequestDescription}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <OAuthConsentCard
      canRespond={canRespond}
      className={className}
      client={client}
      clientName={clientName}
      consent={consent}
      isSessionPending={isSessionPending}
      localization={localization}
      logoUrl={logoUrl}
      policyUrl={policyUrl}
      request={request}
      scopeMetadata={scopeMetadata}
      session={session}
      termsUrl={termsUrl}
    />
  );
};
