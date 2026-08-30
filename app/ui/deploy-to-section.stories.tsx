import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { DeployToSection } from "./app-builder";
import { CreateAppStoryFrame } from "./create-app-story-frame";
import { storyTeamOptions } from "./create-app-story-fixtures";

const meta = {
  title: "Create App/Sections/Deploy To",
  component: DeployToSection,
  args: {
    available: true,
    connected: true,
    onConnect: fn(),
    onProviderChange: fn(),
    onTeamChange: fn(),
    selected: null,
    team: "vercel-autograph",
    teamOptions: storyTeamOptions,
  },
  decorators: [
    (Story) => (
      <CreateAppStoryFrame>
        <Story />
      </CreateAppStoryFrame>
    ),
  ],
} satisfies Meta<typeof DeployToSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const OptionalNone: Story = {};
export const Connected: Story = { args: { selected: "vercel" } };
export const ConnectRequired: Story = {
  args: { selected: "vercel", connected: false },
};
export const Unavailable: Story = {
  args: { available: false, connected: false },
};
export const SelectVercel: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByText("Vercel"));
    await expect(args.onProviderChange).toHaveBeenCalledWith("vercel");
  },
};
export const SelectTeam: Story = {
  args: { selected: "vercel" },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText("Select a Vercel Team"));
    await userEvent.click(canvas.getByRole("option", { name: /Sandbox/ }));
    await expect(args.onTeamChange).toHaveBeenCalledWith("vercel-sandbox");
  },
};
