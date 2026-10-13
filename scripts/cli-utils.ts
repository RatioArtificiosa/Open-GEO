import { existsSync, readFileSync } from "node:fs";
import { at } from "@/shared/index-reads";
import process from "node:process";

export function parseArgs(argv: string[]) {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    // **`at()` rather than `argv[i]`.** The loop bound is `argv.length`, so the
    // index is always in range — which the compiler cannot see. `token` flowed
    // into `startsWith` and then `next` flowed into a flag-name lookup, and a
    // value that may be undefined on the *last* argument is the case this
    // function exists to parse.
    const token = at(argv, i, "the argument list being parsed");
    if (!token.startsWith("--")) continue;
    // The prefix check above guarantees two leading characters, so the slice is
    // never empty-by-underflow. Written against the constant rather than `2` so
    // the two cannot drift.
    const withoutPrefix = token.slice("--".length);
    const sep = withoutPrefix.indexOf("=");
    if (sep >= 0) {
      parsed[withoutPrefix.slice(0, sep)] = withoutPrefix.slice(sep + 1);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[withoutPrefix] = "true";
      continue;
    }
    parsed[withoutPrefix] = next;
    i += 1;
  }
  return parsed;
}

export function loadLocalEnv() {
  for (const path of [".env.local", ".env"]) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const sep = trimmed.indexOf("=");
      if (sep < 0) continue;
      const key = trimmed.slice(0, sep).trim();
      const rawValue = trimmed.slice(sep + 1).trim();
      if (!key || process.env[key]) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
