import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { CreateAppFormStoryLayout } from "@/.storybook/create-app/layouts";
import { SearchCombobox } from "./search-combobox";

const options = [
  { detail: "Pro", label: "Autograph", value: "autograph" },
  { detail: "Hobby", label: "Sandbox", value: "sandbox" },
];
const teamLabel = "Select a Vercel Team";
const connectTeamLabel = "Connect another Vercel team";
const meta = {
  args: {
    label: teamLabel,
    onChange: (...args) => {
      void fn()(...args);
    },
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
    await userEvent.click(canvas.getByLabelText(teamLabel));
    await userEvent.click(canvas.getByRole("option", { name: /Sandbox/u }));
    await expect(args.onChange).toHaveBeenCalledWith("sandbox");
  },
};
export const FooterAction: Story = {
  args: {
    menuFooter: { label: connectTeamLabel, value: "create-team" },
    onFooterSelect: (...args) => {
      void fn()(...args);
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByLabelText(teamLabel));
    await userEvent.click(canvas.getByRole("button", { name: connectTeamLabel }));
    await expect(args.onFooterSelect).toHaveBeenCalledOnce();
  },
};
