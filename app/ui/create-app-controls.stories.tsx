import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import {
  AutographMark,
  Header,
  InfoTooltip,
  SearchCombobox,
} from "./app-builder";

const controls = {
  title: "Features/Create App/Controls",
  component: SearchCombobox,
  args: {
    label: "Select a Vercel Team",
    value: "autograph",
    options: [
      { value: "autograph", label: "Autograph", detail: "Pro" },
      { value: "sandbox", label: "Sandbox", detail: "Hobby" },
    ],
    onChange: fn(),
    prefix: <span aria-hidden="true">●</span>,
  },
} satisfies Meta<typeof SearchCombobox>;

export default controls;
type Story = StoryObj<typeof controls>;

export const Combobox: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText("Select a Vercel Team"));
    await userEvent.click(canvas.getByRole("option", { name: /Sandbox/ }));
    await expect(args.onChange).toHaveBeenCalledWith("sandbox");
  },
};

export const Tooltip: Story = {
  render: () => <InfoTooltip>Only use approved providers.</InfoTooltip>,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("tooltip")).toHaveTextContent(
      "Only use approved providers.",
    );
  },
};

export const Brand: Story = { render: () => <AutographMark /> };
export const CompactBrand: Story = {
  render: () => <AutographMark compact />,
};
export const CreateAppHeader: Story = { render: () => <Header /> };
