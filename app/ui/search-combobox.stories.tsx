import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { SearchCombobox } from "./app-builder";
import { CreateAppStoryFrame } from "./create-app-story-frame";

const options = [
  { value: "autograph", label: "Autograph", detail: "Pro" },
  { value: "sandbox", label: "Sandbox", detail: "Hobby" },
];
const meta = {
  title: "Create App/Primitives/Search Combobox",
  component: SearchCombobox,
  args: {
    label: "Select a Vercel Team",
    value: "autograph",
    options,
    onChange: fn(),
    prefix: <span>●</span>,
  },
  decorators: [
    (Story) => (
      <CreateAppStoryFrame>
        <Story />
      </CreateAppStoryFrame>
    ),
  ],
} satisfies Meta<typeof SearchCombobox>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
export const Empty: Story = {
  args: { value: "", options: [], placeholder: "No teams" },
};
export const SelectOption: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText("Select a Vercel Team"));
    await userEvent.click(canvas.getByRole("option", { name: /Sandbox/ }));
    await expect(args.onChange).toHaveBeenCalledWith("sandbox");
  },
};
export const FooterAction: Story = {
  args: {
    menuFooter: { value: "create-team", label: "Connect another Vercel team" },
    onFooterSelect: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText("Select a Vercel Team"));
    await userEvent.click(
      canvas.getByRole("button", { name: "Connect another Vercel team" }),
    );
    await expect(args.onFooterSelect).toHaveBeenCalledOnce();
  },
};
