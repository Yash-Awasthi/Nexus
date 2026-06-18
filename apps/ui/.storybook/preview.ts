import type { Preview, Decorator } from "@storybook/react";
import React from "react";
import { ThemeProvider } from "../app/context/ThemeContext";

// Apply dark class to html element for dark mode stories
const withThemeProvider: Decorator = (Story, context) => {
  const theme = context.globals.theme ?? "dark";

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return React.createElement(
    ThemeProvider,
    null,
    React.createElement(
      "div",
      {
        style: {
          padding: "1rem",
          background: theme === "dark" ? "#0f172a" : "#ffffff",
          minHeight: "100vh",
          color: theme === "dark" ? "#f8fafc" : "#0f172a",
        },
      },
      React.createElement(Story)
    )
  );
};

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Global theme for components",
      defaultValue: "dark",
      toolbar: {
        title: "Theme",
        icon: "circlehollow",
        items: ["light", "dark"],
        dynamicTitle: true,
      },
    },
  },
  decorators: [withThemeProvider],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: "dark",
      values: [
        { name: "dark", value: "#0f172a" },
        { name: "light", value: "#ffffff" },
        { name: "gray", value: "#f1f5f9" },
      ],
    },
    layout: "centered",
  },
};

export default preview;
