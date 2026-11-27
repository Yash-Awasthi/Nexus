// SPDX-License-Identifier: Apache-2.0
import { CATEGORY_COLORS } from "~/lib/tokens";
import { cn } from "~/lib/utils";

/**
 * A model or provider mark, 14px, drawn from two letters and a colour.
 *
 * The obvious implementation is `@lobehub/icons`, and it was the implementation
 * here for a while: `ProviderIcon` resolves a provider name through a table that
 * imports all 332 provider logos, which rolldown cannot shake, so the workflow page
 * shipped 3.4 MB of icons to draw one 14px square next to a `<select>`. This is the
 * same information at 1 kB: a rounded chip holding the provider's initial, coloured
 * from a stable hash so the same provider is the same colour on every page and every
 * reload.
 */

/**
 * The categorical tokens, in order. They live in `app.css` rather than here so the same eight hues
 * are available to a graph, a chart legend and a glyph — and so the theme can tune them once.
 */
const HUES: string[] = [...CATEGORY_COLORS];

/** Stable per name: `openai` is always the same hue, and hashing never touches the clock. */
export function hueFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return HUES[Math.abs(hash) % HUES.length]!;
}

export function ProviderGlyph({
  provider,
  size = 14,
  className,
  label,
}: {
  provider: string;
  size?: number;
  className?: string;
  /** Overrides the letter — the model mark uses the model name, not the vendor. */
  label?: string;
}) {
  const text = label ?? provider;
  const name = provider || text;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[3px] font-semibold leading-none text-white",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(7, Math.round(size * 0.62)),
        background: hueFor(name.toLowerCase()),
      }}
      title={name}
    >
      {(/[a-z0-9]/i.exec(text)?.[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** The mark for a model id: its first letter, tinted by the provider when one is known. */
export function ModelGlyph({
  model,
  provider,
  size = 14,
}: {
  model: string;
  provider?: string;
  size?: number;
}) {
  return (
    <ProviderGlyph
      provider={provider ?? model}
      label={model}
      size={size}
      className="border border-white/10"
    />
  );
}
