import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  approvalRequest,
  authorizationRequest,
  choiceRequest,
  freeformRequest,
  sessionResult,
} from "@/.storybook/create-app/mcp-fixtures";
import { SessionAppView } from "./view";

const mixedResult = sessionResult([
  choiceRequest,
  freeformRequest,
  approvalRequest,
  authorizationRequest,
]);
const meta = {
  title: "Create App/MCP Blocks/Input Batch",
  component: SessionAppView,
  args: {
    canCallTools: true,
    canOpenLinks: true,
    result: mixedResult,
    onOpenLink: fn(async () => {}),
    onRefresh: fn(async () => {}),
    onRespond: fn(async () => {}),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SessionAppView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MixedRequests: Story = {};
export const HostToolsUnavailable: Story = { args: { canCallTools: false } };
export const Submitted: Story = {
  args: {
    result: { ...mixedResult, status: "working", inputRequests: undefined },
  },
};
export const CompleteBatchAction: Story = {
  args: {
    result: sessionResult([choiceRequest, freeformRequest, approvalRequest]),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Cursor"));
    await userEvent.type(
      canvas.getByLabelText("Who will use this app?"),
      "Finance operators",
    );
    await userEvent.click(canvas.getByText("Approve"));
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(args.onRespond).toHaveBeenCalledOnce();
    await expect(await canvas.findByText("Response received")).toBeVisible();
  },
};
export const SubmittingAndDuplicateProtection: Story = {
  args: {
    result: sessionResult([choiceRequest]),
    onRespond: fn(() => new Promise<void>(() => {})),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Cursor"));
    const button = canvas.getByRole("button", { name: "Continue" });
    await userEvent.dblClick(button);
    await expect(args.onRespond).toHaveBeenCalledOnce();
    await expect(
      canvas.getByRole("button", { name: "Submitting…" }),
    ).toBeDisabled();
  },
};
export const ActionableFailure: Story = {
  args: {
    result: sessionResult([choiceRequest]),
    onRespond: fn(async () => {
      throw new Error("rejected");
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Cursor"));
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Your answers could not be submitted",
    );
  },
};
