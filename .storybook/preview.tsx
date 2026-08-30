import type { Preview } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";

import appStyles from "../app/ui/app-builder.module.css";
import { Providers } from "../components/providers";
import "../app/globals.css";
import "./preview.css";

const CREATE_APP_STORY_PREFIX = "Create App/";

function isCreateAppStory(title: string) {
  return title.startsWith(CREATE_APP_STORY_PREFIX);
}

const preview: Preview = {
  parameters: {
    nextjs: { appDirectory: true },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  decorators: [
    (Story, context) => {
      const story = (
        <Providers>
          <Story />
        </Providers>
      );

      return isCreateAppStory(context.title) ? (
        <div className={appStyles.appShell} data-create-app-story-environment>
          {story}
        </div>
      ) : (
        <div style={{ minHeight: "100vh" }}>{story}</div>
      );
    },
  ],
  afterEach: ({ canvasElement, title }) => {
    if (!isCreateAppStory(title)) return;

    expect(
      canvasElement.querySelector("[data-create-app-story-environment]"),
    ).toBeInTheDocument();
  },
};

export default preview;
