import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";

import { storybookAuthenticatedSession } from "@/.storybook/auth-session";
import { AccountSettings } from "@/components/auth/settings/account/account-settings";
import { UserButton } from "@/components/auth/user/user-button";

function ThemeControls() {
  return (
    <main className="bg-background text-foreground mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-6 p-6">
      <div className="flex justify-end">
        <UserButton align="end" size="icon" />
      </div>
      <AccountSettings />
    </main>
  );
}

const meta = {
  component: ThemeControls,
  parameters: {
    authSession: storybookAuthenticatedSession,
    layout: "fullscreen",
  },
  title: "Components/Auth/Theme Controls",
} satisfies Meta<typeof ThemeControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StockControls: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);

    await expect(canvas.getByText("Appearance")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Account" }));

    const darkTab = await page.findByRole("tab", { name: "Dark" });
    await expect(page.getByRole("tab", { name: "System" })).toBeInTheDocument();
    await expect(page.getByRole("tab", { name: "Light" })).toBeInTheDocument();
    await userEvent.click(darkTab);

    await expect(document.documentElement).toHaveClass("dark");
    await expect(localStorage.getItem("theme")).toBe("dark");

    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      canvas.getByRole("radio", { name: /^Light(?:\s|$)/ })
    );

    await expect(document.documentElement).toHaveClass("light");
    await expect(document.documentElement).not.toHaveClass("dark");
    await expect(localStorage.getItem("theme")).toBe("light");

    await userEvent.click(
      canvas.getByRole("radio", { name: /^System(?:\s|$)/ })
    );
    await expect(localStorage.getItem("theme")).toBe("system");
  },
};
