"use client";

import { useAuth, useAuthPlugin } from "@better-auth-ui/react";
import { Fingerprint, Pencil, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { passkeyPlugin } from "@/lib/auth/passkey-plugin";

import { DeletePasskeyDialog } from "./delete-passkey-dialog";
import type { ListedPasskey } from "./delete-passkey-dialog";
import { RenamePasskeyDialog } from "./rename-passkey-dialog";

export interface PasskeyProps {
  passkey: ListedPasskey;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function Passkey({ passkey }: PasskeyProps) {
  const { localization } = useAuth();
  const { localization: passkeyLocalization } = useAuthPlugin(passkeyPlugin);
  const hydrated = useHydrated();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);

  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- An empty passkey name uses the localized fallback.
  const passkeyName = passkey.name || passkeyLocalization.passkey;
  /* oxlint-enable typescript/strict-boolean-expressions */

  let createdAt = "—";
  if (hydrated) {
    // react-doctor-disable-next-line react-doctor/no-locale-format-in-render -- Formatting occurs only after browser hydration.
    createdAt = new Date(passkey.createdAt).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  return (
    <Item>
      <ItemMedia variant="icon">
        <Fingerprint />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{passkeyName}</ItemTitle>
        <ItemDescription>{createdAt}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setRenameOpen(true);
          }}
        >
          <Pencil />
          {passkeyLocalization.renamePasskey}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setDeleteOpen(true);
          }}
          aria-label={passkeyLocalization.deletePasskey.replace("{{name}}", passkeyName)}
        >
          <X />

          {localization.settings.delete}
        </Button>

        <DeletePasskeyDialog open={deleteOpen} onOpenChange={setDeleteOpen} passkey={passkey} />
        <RenamePasskeyDialog
          key={`${passkey.id}-${passkey.name ?? ""}`}
          open={renameOpen}
          onOpenChange={setRenameOpen}
          passkey={passkey}
        />
      </ItemActions>
    </Item>
  );
}
