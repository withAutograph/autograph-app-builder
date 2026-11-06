"use client";

import { fileToAvatarDataUrl } from "@better-auth-ui/core";
import { useAuth, useSession, useUpdateUser } from "@better-auth-ui/react";
import { Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/auth/user/user-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";

export interface ChangeAvatarProps {
  className?: string;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function ChangeAvatar({ className }: ChangeAvatarProps) {
  const { authClient, localization, avatar } = useAuth();
  const { data: session } = useSession(authClient);

  const { mutate: updateUser, isPending: updatePending } = useUpdateUser(authClient);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const isPending = updatePending || isUploading || isDeleting;

  const finishDelete = async (currentImage: string | null | undefined) => {
    if (currentImage !== undefined && currentImage !== null && currentImage !== "") {
      setIsDeleting(true);
      try {
        await avatar.delete?.(currentImage);
      } finally {
        setIsDeleting(false);
      }
    }

    toast.success(localization.settings.avatarDeletedSuccess);
  };

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file === undefined) {
      return;
    }

    e.target.value = "";

    setIsUploading(true);

    try {
      const resized = (await avatar.resize?.(file, avatar.size, avatar.extension)) ?? file;

      const uploadedImage = await avatar.upload?.(resized);
      const image =
        uploadedImage === undefined || uploadedImage === null || uploadedImage === ""
          ? await fileToAvatarDataUrl(resized)
          : uploadedImage;

      updateUser(
        { image },
        {
          onSuccess: () => {
            toast.success(localization.settings.avatarChangedSuccess);
          },
        },
      );
    } catch (error) {
      if (error instanceof Error) {
        toast.error(error.message);
      }
    }

    setIsUploading(false);
  }

  // eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
  async function handleDelete() {
    const currentImage = session?.user.image;

    updateUser(
      { image: null },
      {
        onSuccess: () => {
          void finishDelete(currentImage);
        },
      },
    );
  }

  return (
    <Field className={className}>
      <FieldLabel>{localization.settings.avatar}</FieldLabel>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          void handleFileChange(event);
        }}
      />

      <div className="flex items-center gap-4">
        <Button
          type="button"
          variant="ghost"
          className="p-0 h-auto w-auto rounded-full"
          disabled={isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          <UserAvatar className="size-12" isPending={isPending} />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex h-7 items-center justify-center rounded-lg border border-transparent bg-secondary px-2.5 text-[0.8rem] font-medium text-secondary-foreground whitespace-nowrap transition-colors hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]"
            disabled={!session || isPending}
          >
            {isPending && <Spinner />}

            {localization.settings.changeAvatar}
          </DropdownMenuTrigger>

          <DropdownMenuContent className="min-w-fit">
            <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
              <Upload className="text-muted-foreground" />

              {localization.settings.uploadAvatar}
            </DropdownMenuItem>

            <DropdownMenuItem
              variant="destructive"
              disabled={
                session?.user.image === undefined ||
                session.user.image === null ||
                session.user.image === ""
              }
              onClick={() => {
                void handleDelete();
              }}
            >
              <Trash2 />

              {localization.settings.deleteAvatar}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Field>
  );
}
