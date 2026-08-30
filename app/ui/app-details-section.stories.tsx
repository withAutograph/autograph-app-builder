import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

import { AppDetailsSection, appNameFromBrief } from "./app-builder";
import { CreateAppStoryFrame } from "./create-app-story-frame";

const meta = {
  title: "Create App/Sections/App Details",
  component: AppDetailsSection,
  args: {
    appName: "Vendor Portal",
    brief: "Build a vendor onboarding portal.",
    onAppNameChange: fn(),
    onBriefChange: fn(),
    onCycleBrief: fn(),
  },
  decorators: [
    (Story) => (
      <CreateAppStoryFrame>
        <Story />
      </CreateAppStoryFrame>
    ),
  ],
} satisfies Meta<typeof AppDetailsSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const Empty: Story = { args: { appName: "", brief: "" } };
export const EditName: Story = {
  play: async ({ canvasElement, args }) => {
    const input = within(canvasElement).getByLabelText("App Name");
    await userEvent.clear(input);
    await userEvent.type(input, "Finance Hub");
    await expect(args.onAppNameChange).toHaveBeenLastCalledWith(
      "Vendor Portalb",
    );
  },
};
export const CycleBrief: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Try another app brief example",
      }),
    );
    await expect(args.onCycleBrief).toHaveBeenCalledOnce();
  },
};

function GeneratedNameHarness() {
  const [brief, setBrief] = useState("");
  const [appName, setAppName] = useState("");
  return (
    <AppDetailsSection
      appName={appName}
      brief={brief}
      onAppNameChange={setAppName}
      onCycleBrief={() => {}}
      onBriefChange={(value) => {
        setBrief(value);
        setAppName(appNameFromBrief(value));
      }}
    />
  );
}
export const GeneratedNameSync: Story = {
  render: () => <GeneratedNameHarness />,
  play: async ({ canvasElement }) => {
    await userEvent.type(
      within(canvasElement).getByLabelText("App Brief"),
      "Build a finance hub",
    );
    await expect(within(canvasElement).getByLabelText("App Name")).toHaveValue(
      "Finance Hub",
    );
  },
};
