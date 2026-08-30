import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { authorizationRequest } from "./story-fixtures";
import { McpStoryFrame } from "./story-frame";
import { AuthorizationControl } from "./view";

const meta = {
  title: "Create App/MCP Blocks/Authorization Request",
  component: AuthorizationControl,
  args: {
    canOpen: true,
    canRefresh: true,
    onOpenLink: fn(async () => {}),
    onRefresh: fn(async () => {}),
    request: authorizationRequest,
  },
  decorators: [
    (Story) => (
      <McpStoryFrame>
        <Story />
      </McpStoryFrame>
    ),
  ],
} satisfies Meta<typeof AuthorizationControl>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LinkAndDeviceCode: Story = {};
export const CodeOnly: Story = {
  args: {
    request: {
      ...authorizationRequest,
      authorization: { ...authorizationRequest.authorization, url: undefined },
    },
  },
};
export const UnsupportedLink: Story = { args: { canOpen: false } };
export const OpenAndRefresh: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
    await expect(args.onOpenLink).toHaveBeenCalledWith(
      "https://github.com/login/device",
    );
    await userEvent.click(
      await canvas.findByRole("button", { name: "Check connection" }),
    );
    await expect(args.onRefresh).toHaveBeenCalledOnce();
  },
};
export const ActionableFailure: Story = {
  args: {
    onOpenLink: fn(async () => {
      throw new Error("blocked");
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
    await expect(
      await canvas.findByText(
        "The authorization page could not be opened. Continue in chat.",
      ),
    ).toBeVisible();
  },
};
