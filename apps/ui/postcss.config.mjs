// SPDX-License-Identifier: Apache-2.0
// Tailwind CSS v4 is wired as a Vite plugin (@tailwindcss/vite), so there is nothing to configure
// for PostCSS itself. This file exists to stop Vite's config search at the app: it otherwise walks
// up past the repo root, and a stray empty package.json up there makes the search throw
// "Unexpected end of JSON input" and every page 500s in dev.
export default { plugins: {} };
