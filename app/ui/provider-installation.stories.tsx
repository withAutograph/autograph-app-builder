import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { FaGithub } from "react-icons/fa";
import { SiVercel } from "react-icons/si";
import { expect, within } from "storybook/test";

import { ProviderConnection, ProviderConnectionNotice } from "./provider-connection";

const meta = {
  args: {
    action: "/github/installations/start",
    buttonLabel: "Continue with GitHub",
    children: null,
    description: "Connect GitHub so Autograph can access the repository for this app.",
    headerLabel: "Connect GitHub",
    icon: <FaGithub size={23} />,
    resumeKey: "resume-123",
    returnTo: "/",
    title: "Connect GitHub",
  },
  component: ProviderConnection,
  parameters: { layout: "fullscreen" },
  title: "Components/Connections/Provider Connection",
} satisfies Meta<typeof ProviderConnection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GitHub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
    await expect(canvas.getAllByRole("button")).toHaveLength(1);
  },
};
export const GitHubConnected: Story = {
  args: {
    children: (
      <ProviderConnectionNotice status="success">
        The GitHub App installation is connected.
      </ProviderConnectionNotice>
    ),
  },
};
export const GitHubFailed: Story = {
  args: {
    children: (
      <ProviderConnectionNotice status="error">
        GitHub could not be connected.
      </ProviderConnectionNotice>
    ),
  },
};
export const Vercel: Story = {
  args: {
    action: "/vercel/installations/start",
    buttonLabel: "Connect to Vercel",
    description:
      "Choose the Vercel account Autograph may use for projects and deployments. Connecting it does not create or deploy anything yet.",
    icon: <SiVercel size={22} />,
    headerLabel: "New App",
    title: "Connect a Vercel team",
  },
};
export const VercelFailed: Story = {
  args: {
    action: "/vercel/installations/start",
    buttonLabel: "Connect to Vercel",
    children: (
      <ProviderConnectionNotice status="error">
        Vercel could not be connected.
      </ProviderConnectionNotice>
    ),
    description:
      "Choose the Vercel account Autograph may use for projects and deployments. Connecting it does not create or deploy anything yet.",
    icon: <SiVercel size={22} />,
    headerLabel: "New App",
    title: "Connect a Vercel team",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("Vercel could not be connected.");
  },
};
