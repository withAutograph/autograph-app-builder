import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { storyGitScopeOptions } from "@/.storybook/create-app/app-builder-fixtures";
import { CreateAppFormStoryLayout } from "@/.storybook/create-app/layouts";
import { StoreInSection } from "./app-builder";

const meta = {
  title: "Create App/Sections/Store In",
  component: StoreInSection,
  args: {
    available: true,
    connected: true,
    gitScope: "101",
    gitScopeOptions: storyGitScopeOptions,
    onConnect: fn(),
    onGitScopeChange: fn(),
    onPrivacyChange: fn(),
    onProviderChange: fn(),
    onRepositoryChange: fn(),
    privateRepository: true,
    repository: "vendor-portal",
    selected: "github",
  },
  decorators: [
    (Story) => (
      <CreateAppFormStoryLayout>
        <Story />
      </CreateAppFormStoryLayout>
    ),
  ],
} satisfies Meta<typeof StoreInSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Connected: Story = {};
export const OptionalNone: Story = { args: { selected: null, gitScope: "" } };
export const ConnectRequired: Story = {
  args: { connected: false, gitScope: "" },
};
export const Unavailable: Story = {
  args: { available: false, connected: false, gitScope: "" },
};
export const SelectScope: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText("Git Scope"));
    await userEvent.click(
      canvas.getByRole("option", { name: /jasonmorganson/ }),
    );
    await expect(args.onGitScopeChange).toHaveBeenCalledWith("202");
  },
};
export const EditRepositoryAndPrivacy: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText("my-app"), "-next");
    await userEvent.click(canvas.getByLabelText("Private repository"));
    await expect(args.onRepositoryChange).toHaveBeenCalled();
    await expect(args.onPrivacyChange).toHaveBeenCalledWith(false);
  },
};
