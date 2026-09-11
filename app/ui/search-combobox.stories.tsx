import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { CreateAppFormStoryLayout } from "@/.storybook/create-app/layouts";

import { SearchCombobox } from "./search-combobox";

const options = [
  { detail: "Pro", label: "Autograph", value: "autograph" },
  { detail: "Hobby", label: "Sandbox", value: "sandbox" },
];
const meta = {
  args: {
    label: "Select a Vercel Team",
    onChange: fn(),
    options,
    prefix: <span>●</span>,
    value: "autograph",
  },
  component: SearchCombobox,
  decorators: [
    (Story) => (
      <CreateAppFormStoryLayout>
        <Story />
      </CreateAppFormStoryLayout>
    ),
  ],
  title: "Components/Create App/Primitives/Search Combobox",
} satisfies Meta<typeof SearchCombobox>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
export const Empty: Story = {
  args: { options: [], placeholder: "No teams", value: "" },
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
    menuFooter: { label: "Connect another Vercel team", value: "create-team" },
    onFooterSelect: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText("Select a Vercel Team"));
    await userEvent.click(
      canvas.getByRole("button", { name: "Connect another Vercel team" })
    );
    await expect(args.onFooterSelect).toHaveBeenCalledOnce();
  },
};
