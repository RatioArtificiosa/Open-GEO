/**
 * Seed the category taxonomy from the vendor's published CSV.
 *
 * Usage:
 *   pnpm db:migrate:local      # once — creates the local D1 with the taxonomy table
 *   pnpm seed:categories       # load all 3,183 rows
 *   pnpm seed:categories --file=path/to/categories.csv   # a republished vintage
 *
 * ## Why the CSV is in the repository
 *
 * The vendor publishes this taxonomy **only** as a CSV on their CDN, dated in its filename
 * because they republish it. Committing it makes the seed offline, deterministic and reviewable:
 * a diff of the file is a diff of the data, which a fetch at seed time would hide behind
 * whatever the CDN served that day. It also means a self-hosted instance can be seeded with no
 * outbound access beyond the API key it already needs.
 *
 * ## Re-running is the point
 *
 * `criterion_id` is the vendor's own ID and the primary key, so a republished taxonomy updates
 * rows in place — which is exactly why this is a table rather than a bundle import. A category
 * renamed or moved in the hierarchy lands as an update, and nothing that references the ID has
 * to change.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import { getPlatformProxy } from "wrangler";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import * as appSchema from "../src/db/app.schema";
import { categoryTaxonomy } from "../src/db/labs-categories.schema";
import { parseArgs } from "./cli-utils";
import { parseCategoryCsv } from "./category-csv";

const schema = { ...appSchema, categoryTaxonomy };

/** The vintage the repository ships, unless a caller names another. */
const DEFAULT_FILE = "scripts/data/categories_dataforseo_labs_2023_10_25.csv";

/**
 * Rows per insert.
 *
 * **D1 rejects a statement with too many bound parameters** — it failed at 465 for a 250-row
 * batch ("too many SQL variables"), and its documented ceiling is far below SQLite's own 999. So
 * this is deliberately small: 25 rows is 50 parameters, which leaves no doubt, and 128 round
 * trips over 3,182 rows is a few seconds for a seed that runs once per taxonomy vintage.
 */
const BATCH_SIZE = 25;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file ?? DEFAULT_FILE;
  const { rows, malformed } = parseCategoryCsv(readFileSync(file, "utf8"));

  if (malformed.length > 0) {
    console.error(
      `Refusing to seed: ${malformed.length} line(s) could not be parsed. First:`,
    );
    for (const entry of malformed.slice(0, 5)) {
      console.error(`  line ${entry.line}: ${entry.text}`);
    }
    process.exit(1);
  }

  console.log(`Read ${rows.length} categories from ${file}`);
  const { env, dispose } = await getPlatformProxy<{ DB: D1Database }>();
  const db = drizzle(env.DB, { schema });

  try {
    for (let start = 0; start < rows.length; start += BATCH_SIZE) {
      const batch = rows.slice(start, start + BATCH_SIZE);
      await db
        .insert(categoryTaxonomy)
        .values(batch)
        // `excluded` is the row proposed by this insert, so a republished taxonomy updates a
        // category's name in place rather than failing on the primary key — the whole reason the
        // vendor's ID is the key rather than one of ours.
        .onConflictDoUpdate({
          target: categoryTaxonomy.criterionId,
          set: { path: sql`excluded.path` },
        });
    }
    console.log(`Seeded ${rows.length} categories (${file}).`);
  } finally {
    await dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
