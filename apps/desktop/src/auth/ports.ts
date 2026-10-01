// SPDX-License-Identifier: Apache-2.0
/**
 * Concrete ports for the sign-in flow: JSON over HTTP, and one sealed file.
 *
 * Both are thin on purpose. The flow they serve lives in `session.ts` and is
 * tested against fakes, so anything with a decision in it belongs there rather
 * than here.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { JsonHttp, SessionFile } from "./session";

/** A response body that is not JSON tells us nothing worth parsing. */
async function asJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return { error: `unexpected response (${res.status})` };
  }
}

export const fetchJsonHttp: JsonHttp = {
  async getJson(url, accessToken) {
    const res = await fetch(url, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    return asJson(res);
  },
  async postJson(url, body, accessToken) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    return asJson(res);
  },
};

/** The sealed session blob. Only ever holds output from the keychain vault. */
export function createSessionFile(path: string): SessionFile {
  return {
    read: () => (existsSync(path) ? readFileSync(path, "utf8") : null),
    write: (sealed) => writeFileSync(path, sealed, { encoding: "utf8", mode: 0o600 }),
    clear: () => rmSync(path, { force: true }),
  };
}
