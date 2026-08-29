import { AccountSettings } from "@/components/auth/settings/account/account-settings";

export default function AccountSettingsPage() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Account settings</h1>
      <AccountSettings />
    </main>
  );
}
