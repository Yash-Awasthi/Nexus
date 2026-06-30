// SPDX-License-Identifier: Apache-2.0
/**
 * Provider registry — holds the live AuthProvider plugins and exposes the
 * catalog (including unsupported/skip-with-TODO entries) for UI + diagnostics.
 */
import { DESCRIPTORS, GoogleVertexAuthProvider } from "./providers.js";
import type { AuthProvider, ProviderDescriptor } from "./types.js";

export class AuthProviderRegistry {
  private readonly providers = new Map<string, AuthProvider>();

  /** Register a plugin. Throws on duplicate id. */
  register(provider: AuthProvider): this {
    if (this.providers.has(provider.id)) {
      throw new Error(`AuthProviderRegistry: duplicate provider id "${provider.id}"`);
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): AuthProvider | undefined {
    return this.providers.get(id);
  }

  list(): AuthProvider[] {
    return [...this.providers.values()];
  }

  /** Full catalog: supported (with a live plugin) + skip-with-TODO stubs. */
  catalog(): ProviderDescriptor[] {
    const live = new Set(this.providers.keys());
    return DESCRIPTORS.map((d) => ({ ...d, supported: d.supported && live.has(d.id) }));
  }
}

/**
 * Build a registry from env, registering only providers whose operator-owned
 * OAuth app is fully configured. A provider with missing env is left OUT (its
 * catalog entry stays `supported: false`) rather than half-registered.
 */
export function registryFromEnv(env: NodeJS.ProcessEnv = process.env): AuthProviderRegistry {
  const reg = new AuthProviderRegistry();
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_CLOUD_PROJECT) {
    reg.register(
      new GoogleVertexAuthProvider({
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        project: env.GOOGLE_CLOUD_PROJECT,
        region: env.GOOGLE_CLOUD_REGION,
      }),
    );
  }
  return reg;
}
