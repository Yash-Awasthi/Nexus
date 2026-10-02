// SPDX-License-Identifier: Apache-2.0
/**
 * App generation starts from a known-good project instead of an empty folder: a
 * design is picked from fixed options, a Vite + React + Tailwind starter is written
 * with it, and a coding agent then customises that starter.
 */
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const DESIGN_OPTIONS = {
  style: ["minimal", "soft", "bold", "brutalist", "elegant"],
  color: {
    slate: "#475569",
    zinc: "#52525b",
    stone: "#57534e",
    red: "#dc2626",
    orange: "#ea580c",
    amber: "#d97706",
    yellow: "#ca8a04",
    lime: "#65a30d",
    green: "#16a34a",
    emerald: "#059669",
    teal: "#0d9488",
    cyan: "#0891b2",
    sky: "#0284c7",
    blue: "#2563eb",
    indigo: "#4f46e5",
    violet: "#7c3aed",
    purple: "#9333ea",
    fuchsia: "#c026d3",
    pink: "#db2777",
    rose: "#e11d48",
  },
  font: {
    inter: "Inter",
    "dm-sans": "DM Sans",
    "space-grotesk": "Space Grotesk",
    lora: "Lora",
  },
  radius: { none: "0rem", sm: "0.25rem", md: "0.5rem", lg: "0.75rem", xl: "1rem" },
} as const;

export interface AppDesign {
  style: (typeof DESIGN_OPTIONS.style)[number];
  color: keyof typeof DESIGN_OPTIONS.color;
  font: keyof typeof DESIGN_OPTIONS.font;
  radius: keyof typeof DESIGN_OPTIONS.radius;
}

const STYLE_TOKENS: Record<AppDesign["style"], { shadow: string; border: string }> = {
  minimal: { shadow: "none", border: "1px" },
  soft: { shadow: "0 8px 24px -12px rgb(0 0 0 / 0.25)", border: "0px" },
  bold: { shadow: "0 4px 0 0 rgb(0 0 0 / 0.9)", border: "2px" },
  brutalist: { shadow: "6px 6px 0 0 rgb(0 0 0)", border: "3px" },
  elegant: { shadow: "0 1px 2px rgb(0 0 0 / 0.08)", border: "1px" },
};

/** The design in `raw` when every field names an allowed option, else null. */
export function parseDesign(raw: unknown): AppDesign | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const ok =
    (DESIGN_OPTIONS.style as readonly unknown[]).includes(d.style) &&
    typeof d.color === "string" &&
    Object.hasOwn(DESIGN_OPTIONS.color, d.color) &&
    typeof d.font === "string" &&
    Object.hasOwn(DESIGN_OPTIONS.font, d.font) &&
    typeof d.radius === "string" &&
    Object.hasOwn(DESIGN_OPTIONS.radius, d.radius);
  return ok
    ? {
        style: d.style as AppDesign["style"],
        color: d.color as AppDesign["color"],
        font: d.font as AppDesign["font"],
        radius: d.radius as AppDesign["radius"],
      }
    : null;
}

/** A design derived from the prompt alone, so the same prompt always gets the same look. */
export function fallbackDesign(prompt: string): AppDesign {
  const h = crypto.createHash("sha256").update(prompt).digest();
  const pick = <T>(list: readonly T[], i: number): T => list[h[i]! % list.length]!;
  return {
    style: pick(DESIGN_OPTIONS.style, 0),
    color: pick(Object.keys(DESIGN_OPTIONS.color), 1) as AppDesign["color"],
    font: pick(Object.keys(DESIGN_OPTIONS.font), 2) as AppDesign["font"],
    radius: pick(Object.keys(DESIGN_OPTIONS.radius), 3) as AppDesign["radius"],
  };
}

/** Ask a model to choose among the options; any answer outside them falls back. */
export async function pickDesign(
  prompt: string,
  complete?: (question: string) => Promise<string>,
): Promise<AppDesign> {
  if (!complete) return fallbackDesign(prompt);
  const question =
    `Choose a visual design for this app: ${JSON.stringify(prompt.slice(0, 2000))}\n` +
    `Answer with JSON only: {"style","color","font","radius"}, each one of:\n` +
    `style: ${DESIGN_OPTIONS.style.join(", ")}\n` +
    `color: ${Object.keys(DESIGN_OPTIONS.color).join(", ")}\n` +
    `font: ${Object.keys(DESIGN_OPTIONS.font).join(", ")}\n` +
    `radius: ${Object.keys(DESIGN_OPTIONS.radius).join(", ")}`;
  try {
    const answer = await complete(question);
    const json = answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1);
    return parseDesign(JSON.parse(json)) ?? fallbackDesign(prompt);
  } catch {
    return fallbackDesign(prompt);
  }
}

// A slug of the prompt plus a hash, stable per owner and prompt. Short, because npm on Windows
// fails once node_modules paths pass 260 characters.
export function appFolderName(ownerId: string, prompt: string): string {
  const slug =
    prompt
      .slice(0, 200)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20)
      .replace(/-+$/, "") || "app";
  const hash = crypto.createHash("sha256").update(`${ownerId}:${prompt}`).digest("hex").slice(0, 6);
  return `${slug}-${hash}`;
}

export const DESIGN_FILE = "nexus-design.json";

function starterFiles(name: string, design: AppDesign): Record<string, string> {
  const font = DESIGN_OPTIONS.font[design.font];
  const tokens = STYLE_TOKENS[design.style];
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  return {
    [DESIGN_FILE]: json(design),
    ".gitignore": "node_modules\ndist\n",
    "package.json": json({
      name,
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: { dev: "vite", build: "tsc -b && vite build", preview: "vite preview" },
      // What shadcn components import, so adding one needs no install of its own.
      dependencies: {
        "class-variance-authority": "^0.7.1",
        clsx: "^2.1.1",
        "lucide-react": "^1.48.0",
        "radix-ui": "^1.6.7",
        react: "^19.1.0",
        "react-dom": "^19.1.0",
        "react-router": "^7.6.0",
        "tailwind-merge": "^3.3.0",
      },
      devDependencies: {
        "@tailwindcss/vite": "^4.1.0",
        "@types/node": "^22.15.0",
        "@types/react": "^19.1.0",
        "@types/react-dom": "^19.1.0",
        "@vitejs/plugin-react": "^4.5.0",
        tailwindcss: "^4.1.0",
        typescript: "^5.8.0",
        vite: "^6.3.0",
      },
    }),
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        baseUrl: ".",
        paths: { "@/*": ["./src/*"] },
      },
      include: ["src"],
    }),
    "vite.config.ts": [
      'import path from "node:path";',
      'import tailwindcss from "@tailwindcss/vite";',
      'import react from "@vitejs/plugin-react";',
      'import { defineConfig } from "vite";',
      "",
      "export default defineConfig({",
      "  plugins: [react(), tailwindcss()],",
      '  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },',
      "});",
      "",
    ].join("\n"),
    // shadcn/ui's CLI reads this, so `npx shadcn@latest add button` works in the project.
    "components.json": json({
      $schema: "https://ui.shadcn.com/schema.json",
      style: "new-york",
      rsc: false,
      tsx: true,
      tailwind: { config: "", css: "src/index.css", baseColor: "neutral", cssVariables: true },
      aliases: { components: "@/components", utils: "@/lib/utils", ui: "@/components/ui" },
    }),
    "index.html": [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      `    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${font.replace(/ /g, "+")}:wght@400;500;600;700&display=swap" />`,
      `    <title>${name}</title>`,
      "  </head>",
      "  <body>",
      '    <div id="root"></div>',
      '    <script type="module" src="/src/main.tsx"></script>',
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
    "src/index.css": [
      '@import "tailwindcss";',
      "",
      "@theme {",
      `  --font-sans: "${font}", ui-sans-serif, system-ui, sans-serif;`,
      `  --color-primary: ${DESIGN_OPTIONS.color[design.color]};`,
      "  --color-primary-foreground: #ffffff;",
      `  --radius: ${DESIGN_OPTIONS.radius[design.radius]};`,
      `  --shadow-card: ${tokens.shadow};`,
      "}",
      "",
      // The colour names shadcn components use; without them cards, inputs and rings are unstyled.
      ":root {",
      `  --border-width: ${tokens.border};`,
      "  --background: #ffffff;",
      "  --foreground: #171717;",
      "  --card: #ffffff;",
      "  --card-foreground: #171717;",
      "  --popover: #ffffff;",
      "  --popover-foreground: #171717;",
      "  --secondary: #f5f5f5;",
      "  --secondary-foreground: #262626;",
      "  --muted: #f5f5f5;",
      "  --muted-foreground: #737373;",
      "  --accent: #f5f5f5;",
      "  --accent-foreground: #262626;",
      "  --destructive: #dc2626;",
      "  --border: #e5e5e5;",
      "  --input: #e5e5e5;",
      `  --ring: ${DESIGN_OPTIONS.color[design.color]};`,
      "}",
      "",
      "@theme inline {",
      ...[
        "background",
        "foreground",
        "card",
        "card-foreground",
        "popover",
        "popover-foreground",
        "secondary",
        "secondary-foreground",
        "muted",
        "muted-foreground",
        "accent",
        "accent-foreground",
        "destructive",
        "border",
        "input",
        "ring",
      ].map((c) => `  --color-${c}: var(--${c});`),
      "  --radius-sm: calc(var(--radius) * 0.6);",
      "  --radius-md: calc(var(--radius) * 0.8);",
      "  --radius-lg: var(--radius);",
      "  --radius-xl: calc(var(--radius) * 1.4);",
      "}",
      "",
      "body {",
      "  @apply bg-background text-foreground font-sans antialiased;",
      "}",
      "",
    ].join("\n"),
    "src/lib/utils.ts": [
      'import { clsx, type ClassValue } from "clsx";',
      'import { twMerge } from "tailwind-merge";',
      "",
      "export function cn(...inputs: ClassValue[]) {",
      "  return twMerge(clsx(inputs));",
      "}",
      "",
    ].join("\n"),
    "src/main.tsx": [
      'import { StrictMode } from "react";',
      'import { createRoot } from "react-dom/client";',
      'import { BrowserRouter, Route, Routes } from "react-router";',
      "",
      'import App from "./App";',
      'import "./index.css";',
      "",
      'createRoot(document.getElementById("root")!).render(',
      "  <StrictMode>",
      "    <BrowserRouter>",
      "      <Routes>",
      '        <Route path="/" element={<App />} />',
      "      </Routes>",
      "    </BrowserRouter>",
      "  </StrictMode>,",
      ");",
      "",
    ].join("\n"),
    "src/App.tsx": [
      "export default function App() {",
      "  return (",
      '    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-4 p-8">',
      `      <h1 className="text-4xl font-bold text-primary">${name}</h1>`,
      '      <p className="text-neutral-600">Starter page.</p>',
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n"),
  };
}

/** Write the starter into `dir`. Existing files are kept, so a resumed run never loses edits. */
export async function scaffoldApp(dir: string, name: string, design: AppDesign): Promise<void> {
  for (const [rel, content] of Object.entries(starterFiles(name, design))) {
    const file = path.join(dir, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
  }
}

/** The coding agent's instruction for customising the scaffold. */
export function codegenInstruction(prompt: string, design: AppDesign): string {
  return [
    `Build this app by editing the starter project in the working directory: ${prompt}`,
    "",
    "The starter is Vite + React 19 + TypeScript + Tailwind CSS v4 + React Router 7, already",
    `themed (${design.style} style, ${design.color} primary, ${DESIGN_OPTIONS.font[design.font]}, ${design.radius} radius)`,
    "through the tokens in src/index.css. Keep that theme: use text-primary, bg-primary, the shadcn",
    "colours (bg-card, text-muted-foreground, border-input), rounded-lg and shadow-card, not new colours.",
    "",
    "- Add routes in src/main.tsx and put pages under src/pages/.",
    "- shadcn/ui is configured: run `npx shadcn@latest add <component>` for buttons, cards,",
    "  dialogs and the like instead of writing them by hand.",
    "- Install packages with npm. When done, run `npm run build` and fix every error it reports.",
    "- Run each command plainly, without piping or trimming its output.",
    "- A clean `npm run build` is the check: once it passes, do not write check scripts or",
    "  inspect the built files. Delete node_modules and dist, then reply with a short summary.",
  ].join("\n");
}
