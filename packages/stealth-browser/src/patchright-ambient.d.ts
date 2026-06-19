// SPDX-License-Identifier: Apache-2.0
// Ambient type declaration for the optional `patchright` peer dependency.
// patchright is loaded exclusively via dynamic import() inside try/catch blocks
// so it is never a hard runtime requirement. This stub satisfies the TypeScript
// NodeNext module resolver without installing the package.
declare module "patchright" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chromium: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export default chromium as any;
  export { chromium };
}
