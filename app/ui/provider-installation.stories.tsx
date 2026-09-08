import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { FaGithub } from "react-icons/fa";
import { SiVercel } from "react-icons/si";
import { expect, within } from "storybook/test";

import {
  ProviderConnection,
  ProviderConnectionNotice,
} from "./provider-connection";

const meta = {
  title: "Components/Provider Connection",
  component: ProviderConnection,
  args: {
    action: "/github/installations/start",
    buttonLabel: "Install or update GitHub access",
    children: null,
    description:
      "Choose the repositories this workspace may inspect or update, or allow all repositories. For an existing installation, GitHub must have Redirect on update enabled to return here.",
    icon: <FaGithub size={23} />,
    returnTo: "/",
    resumeKey: "resume-123",
    title: "Connect a GitHub App installation",
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ProviderConnection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GitHub: Story = {};
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
    title: "Connect a Vercel team",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Vercel could not be connected.",
    );
  },
};
