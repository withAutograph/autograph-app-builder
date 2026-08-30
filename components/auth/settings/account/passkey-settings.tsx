"use client";

import { Fingerprint } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

export function PasskeySettings() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();

  const addPasskey = async () => {
    setPending(true);
    setMessage(undefined);
    try {
      const result = await authClient.passkey.addPasskey({
        name: "Additional passkey",
      });
      if (result.error) throw new Error(result.error.message);
      setMessage("Passkey added.");
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "Unable to add the passkey.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        <p className="text-muted-foreground text-sm">
          Add another passkey before removing or losing your primary one.
        </p>
        <Button type="button" onClick={addPasskey} disabled={pending}>
          <Fingerprint />
          {pending ? "Adding passkey…" : "Add another passkey"}
        </Button>
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
