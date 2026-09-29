import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  draftPullRequestApprovalRequest,
  sessionResult,
} from "@/.storybook/create-app/mcp-fixtures";
import type { SessionResponse } from "./view";
import { SessionAppView } from "./view";

type ResponseMode = "success" | "failure" | "pending";

interface GitHubDraftPRApprovalProps {
  canCallTools: boolean;
  description: string;
  onRespond: (responses: SessionResponse[]) => Promise<void>;
  responseMode: ResponseMode;
  title: string;
}

const GitHubDraftPRApprovalDemo = ({
  canCallTools,
  description,
  onRespond,
  responseMode,
  title,
}: GitHubDraftPRApprovalProps) => {
  const request = { ...draftPullRequestApprovalRequest, description, title };

  const respond = async (responses: SessionResponse[]) => {
    await onRespond(responses);
    if (responseMode === "failure") {
      throw new Error("The draft PR update was rejected.");
    }
    if (responseMode === "pending") {
      await Promise.withResolvers<undefined>().promise;
    }
  };

  return (
    <SessionAppView
      canCallTools={canCallTools}
      canOpenLinks={false}
      onOpenLink={async () => {
        await Promise.resolve();
      }}
      onRespond={respond}
      result={sessionResult([request])}
    />
  );
};

const meta = {
  argTypes: {
    canCallTools: { control: "boolean", description: "Whether the response can be submitted." },
    description: { control: "text", description: "Supporting copy shown under the request." },
    responseMode: {
      control: "select",
      description: "Outcome to show after the user chooses Accept or Cancel.",
      options: ["success", "failure", "pending"],
    },
    title: { control: "text", description: "Approval heading." },
  },
  args: {
    canCallTools: true,
    description: draftPullRequestApprovalRequest.description,
    onRespond: fn(async () => {
      await Promise.resolve();
    }),
    responseMode: "success",
    title: draftPullRequestApprovalRequest.title,
  },
  component: GitHubDraftPRApprovalDemo,
  parameters: { layout: "fullscreen" },
  title: "MCP/Authorization/Approval Request/GitHub Draft PR",
} satisfies Meta<typeof GitHubDraftPRApprovalDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const GitHubDraftPRApproval: Story = {};

export const DraftPRSubmitted: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Update draft PR #1500?" })).toBeVisible();
    await expect(
      canvas.getByText(
        "Update draft PR #1500 in withAutograph/arrusted-development with eight reviewed Spend Review files. The PR will remain a draft and will not be merged or deployed.",
      ),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Accept" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await expect(canvas.queryByRole("checkbox")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Accept" }));
    await expect(args.onRespond).toHaveBeenCalledOnce();
    await expect(args.onRespond).toHaveBeenCalledWith([
      {
        requestId: "publish-reviewed-changes",
        response: {
          kind: "answer",
          optionId: "update-draft",
          value: "Update draft PR",
        },
      },
    ]);
    await expect(await canvas.findByRole("status")).toHaveTextContent("Draft PR #1500 updated");
    await expect(canvas.getByText(/remains a draft and will not merge or deploy/u)).toBeVisible();
  },
};

export const CancelDraftPRApproval: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(args.onRespond).toHaveBeenCalledOnce();
    await expect(args.onRespond).toHaveBeenCalledWith([
      {
        requestId: "publish-reviewed-changes",
        response: {
          kind: "answer",
          optionId: "cancel-update",
          value: "Do not update",
        },
      },
    ]);
    await expect(await canvas.findByRole("status")).toHaveTextContent("Continuing in chat…");
    await expect(canvas.queryByText("✓")).not.toBeInTheDocument();
  },
};

export const DraftPRSubmitting: Story = {
  args: { responseMode: "pending" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Accept" }));
    await expect(canvas.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(canvas.queryByRole("status")).not.toBeInTheDocument();
  },
};

export const DraftPRFailed: Story = {
  args: { responseMode: "failure" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Accept" }));
    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent("Draft PR #1500 could not be updated");
    await expect(alert).toHaveTextContent("The draft PR update was rejected.");
    await expect(canvas.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  },
};
