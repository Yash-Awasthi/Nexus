// SPDX-License-Identifier: Apache-2.0
import { NexusClient } from "@nexus/client";

const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
const apiKey = (import.meta.env.VITE_API_KEY as string | undefined) ?? "";

export const nexus = new NexusClient({ baseUrl, apiKey });

export type { NexusClient };
