import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { authorizationRequest } from "@/.storybook/create-app/mcp-fixtures";
import { McpBlockStoryLayout } from "@/.storybook/create-app/layouts";
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
      <McpBlockStoryLayout>
        <Story />
      </McpBlockStoryLayout>
    ),
  ],
} satisfies Meta<typeof AuthorizationControl>;
export default meta;
type Story = StoryObj<typeof meta>;
export const UpdateRepositoryAccess: Story = {};
export const FirstConnection: Story = {
  args: {
    request: {
      ...authorizationRequest,
      title: "Connect GitHub",
      authorization: {
        ...authorizationRequest.authorization,
        repositoryAccess: {
          provider: "github",
          action: "connect",
          repository: {
            owner: "withAutograph",
            name: "app-builder-dogfood",
            fullName: "withAutograph/app-builder-dogfood",
          },
          scopes: [],
        },
      },
    },
  },
};
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
    await expect(
      canvas.getByText("Update GitHub access", { selector: "strong" }),
    ).toBeVisible();
    await expect(
      canvas.getByText("withAutograph/app-builder-dogfood"),
    ).toBeVisible();
    await expect(canvas.getByText("Connected to withAutograph")).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Update GitHub access" }),
    );
    await expect(args.onOpenLink).toHaveBeenCalledWith(
      "https://builder.example.test/github/installations?continuation=opaque",
    );
    await userEvent.click(
      await canvas.findByRole("button", { name: "Check access" }),
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
    await userEvent.click(
      canvas.getByRole("button", { name: "Update GitHub access" }),
    );
    await expect(
      await canvas.findByText(
        "The authorization page could not be opened. Continue in chat.",
      ),
    ).toBeVisible();
  },
};
