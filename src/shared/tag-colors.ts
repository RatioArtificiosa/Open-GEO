import { at } from "./index-reads";

export const TAG_COLOR_KEYS = [
  "slate",
  "rose",
  "amber",
  "lime",
  "emerald",
  "sky",
  "violet",
  "fuchsia",
] as const;

export type TagColorKey = (typeof TAG_COLOR_KEYS)[number];

function isTagColorKey(value: unknown): value is TagColorKey {
  return (
    typeof value === "string" &&
    (TAG_COLOR_KEYS as readonly string[]).includes(value)
  );
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function resolveTagColor(tag: {
  id: string;
  color?: string | null;
}): TagColorKey {
  if (isTagColorKey(tag.color)) return tag.color;
  // **`at()` rather than an index.** `hashString` is non-negative and the modulo is
  // taken against `TAG_COLOR_KEYS.length`, so the index is always in range; the
  // compiler types it as possibly-undefined and a `TagColorKey | undefined` return
  // would have made every caller narrow a colour that is always present.
  return at(
    TAG_COLOR_KEYS,
    hashString(tag.id) % TAG_COLOR_KEYS.length,
    "the tag colour palette",
  );
}

const COLOR_CLASS: Record<TagColorKey, string> = {
  slate: "bg-slate-500",
  rose: "bg-rose-500",
  amber: "bg-amber-500",
  lime: "bg-lime-500",
  emerald: "bg-emerald-500",
  sky: "bg-sky-500",
  violet: "bg-violet-500",
  fuchsia: "bg-fuchsia-500",
};

export function tagChipClass(color: TagColorKey): string {
  return `tag-chip-${color} ring-1 ring-inset`;
}

export function tagDotClass(color: TagColorKey): string {
  return COLOR_CLASS[color];
}

export function tagSwatchClass(color: TagColorKey): string {
  return COLOR_CLASS[color];
}
