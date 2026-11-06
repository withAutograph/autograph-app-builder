import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { authorizationRequest } from "@/.storybook/create-app/mcp-fixtures";
import { McpBlockStoryLayout } from "@/.storybook/create-app/layouts";
import { AuthorizationControl } from "./view";

const meta = {
  args: {
    canOpen: true,
    onOpenLink: fn(async () => {
      // Story fixture callback.
    }),
    request: authorizationRequest,
  },
  component: AuthorizationControl,
  decorators: [
    (Story) => (
      <McpBlockStoryLayout>
        <Story />
      </McpBlockStoryLayout>
    ),
  ],
  title: "MCP/Authorization/Authorization Request",
} satisfies Meta<typeof AuthorizationControl>;
export default meta;
type Story = StoryObj<typeof meta>;
export const UpdateRepositoryAccess: Story = {};
export const FirstConnection: Story = {
  args: {
    request: {
      ...authorizationRequest,
      authorization: {
        ...authorizationRequest.authorization,
        repositoryAccess: {
          action: "connect",
          provider: "github",
          repository: {
            fullName: "withAutograph/app-builder-dogfood",
            name: "app-builder-dogfood",
            owner: "withAutograph",
          },
          scopes: [],
        },
      },
      title: "Connect GitHub",
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
export const ContinueWithGitHub: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Connect GitHub", { selector: "strong" })).toBeVisible();
    await expect(canvas.getByText(/withAutograph\/app-builder-dogfood/u)).toBeVisible();
    await expect(canvas.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(canvas.getByRole("button", { name: "Continue with GitHub" }));
    await expect(args.onOpenLink).toHaveBeenCalledWith(
      "https://builder.example.test/github/installations?continuation=opaque",
    );
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "Autograph will show whether access was confirmed",
    );
  },
};
export const ActionableFailure: Story = {
  args: {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    onOpenLink: fn(async () => {
      throw new Error("blocked");
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Continue with GitHub" }));
    await expect(
      await canvas.findByText("The GitHub page could not be opened. Try again."),
    ).toBeVisible();
  },
};
