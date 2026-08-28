"use client";

import { AuthPrompts, useAuth } from "@better-auth-ui/react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ProviderButtons, type SocialLayout } from "./provider-buttons";

export type SignInProps = {
  className?: string;
  socialLayout?: SocialLayout;
  socialPosition?: "top" | "bottom";
};

/** Render the Better Auth UI sign-in card for configured social providers. */
export function SignIn({ className, socialLayout }: SignInProps) {
  const { localization, socialProviders } = useAuth();

  return (
    <Card className={cn("w-full max-w-sm", className)}>
      <AuthPrompts view="signIn" />
      <CardHeader>
        <CardTitle className="text-xl font-semibold">
          {localization.auth.signIn}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {socialProviders && socialProviders.length > 0 ? (
          <ProviderButtons socialLayout={socialLayout} view="signIn" />
        ) : null}
      </CardContent>
    </Card>
  );
}
