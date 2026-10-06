import { z } from "zod";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { NO_RETRY_BILLED_POST } from "@/server/lib/dataforseo/billedTasks";
import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";

/**
 * `on_page/content_parsing` — the structure of a page, parsed.
 *
 * ## This client has no caller, and that is a decision rather than an oversight
 *
 * Nothing in the product invokes either half. Every field it would return, this repo
 * already extracts from bytes it has paid to download: `analyzeHtml` reads heading text
 * and schema types locally during the crawl, and `runReadiness` records the same refusal
 * at the point of use (`src/server/features/audit/services/runReadiness.ts`, "What it
 * deliberately does not do"). **Two sources for one field means a disagreement nobody
 * would notice**, and the vendor's parse is not more true than the page the crawler
 * actually fetched.
 *
 * So: read the readiness note before wiring this up, and delete this file rather than
 * leaving it as the obvious-looking answer if the local extraction ever covers it fully.
 *
 * ## Why this is two calls and not one
 *
 * The vendor **will not parse a page on demand.** `content_parsing` takes a
 * `task_id`, not a URL, and that task only exists if the original
 * `on_page/task_post` asked for the parsing with `enable_content_parsing: true`.
 * A URL passed here is answered with 40501 "Invalid Field" — and the POST is
 * billed either way. So the flag has to be set at post time, which makes the
 * unit of work a **pair** with two separate charges:
 *
 * - the **POST** is a real crawl, billed at the base page price plus any
 *   resource loading the task performed;
 * - the **content_parsing read** is billed again, per call.
 *
 * ## Why both halves are metered — the opposite of `task_get`
 *
 * The unmetered collectors in this directory (`fetchBusinessDataTaskResult`,
 * `fetchRankCheckTaskResult`) are free reads of a task already charged at post
 * time, so routing them through the metering seam would bill twice. **This is
 * not that case:** `content_parsing` carries its own `cost` on every call and
 * the vendor prices it separately. Treating it as free would undercharge every
 * audit by an amount that never appears in the ledger — and *the ceiling does
 * not know what it did not measure.*
 *
 * ## What this endpoint does **not** return
 *
 * **No schema.org.** The documented payload is `header`, `footer`,
 * `primary_content`, `secondary_content`, `table_content`, `main_topic` and
 * `page_as_markdown`. Microdata is a field of the **task_post** result, not of
 * this one, so `schemaTypes` is deliberately **absent** from this result type
 * rather than present-and-null: a caller filling in a citability rubric needs
 * to be able to tell *"the parse found no schema"* from *"schema was never
 * looked for"*, and returning `null` for both destroys that. The type having no
 * such field is the honest answer, and the audit scorer already treats an
 * absent schema signal as *not measured* rather than *zero*.
 *
 * ## The 30-day window
 *
 * Like `serp/ai_summary`, the task id stays valid for 30 days, so a past parse
 * can be re-read without re-paying the crawl. That is why the only per-read
 * option is `markdownView`.
 *
 * Verified against the live documentation on 2026-10-04.
 */

const TASK_POST_PATH = "/v3/on_page/task_post";
const CONTENT_PARSING_PATH = "/v3/on_page/content_parsing";

const classifyOnPageError = createDataforseoBillingClassifier({
  pathPrefix: "/on_page/",
  // There is no `ON_PAGE_BILLING_ISSUE` in `shared/error-codes.ts`. Rather than
  // invent one — which would need a message and a client mapping to say exactly
  // what an existing code already says — this reuses the balance-failure code
  // already wired for the other billed families.
  billingIssueCode: "BACKLINKS_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

/**
 * One content element. **Every field is nullable, and that is the point:** a page
 * with no table has `table_content: null`, and collapsing that to `[]` would claim
 * the page *had* an empty table — a statement about the page, not about our parse.
 */
const contentElementSchema = z
  .object({
    text: z.string().nullish(),
    url: z.string().nullish(),
    urls: z
      .array(
        z
          .object({
            url: z.string().nullish(),
            anchor_text: z.string().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

/** A heading block from `main_topic`. */
const topicSchema = z
  .object({
    h_title: z.string().nullish(),
    main_title: z.string().nullish(),
    author: z.string().nullish(),
    language: z.string().nullish(),
    /** HTML level. **The vendor sends a string** (`"1"`, `"3"`), not a number. */
    level: z.union([z.string(), z.number()]).nullish(),
    primary_content: z.array(contentElementSchema).nullish(),
    secondary_content: z.array(contentElementSchema).nullish(),
  })
  .passthrough();

const parsedPageSchema = z
  .object({
    header: contentElementSchema.nullish(),
    footer: contentElementSchema.nullish(),
    primary_content: z.array(contentElementSchema).nullish(),
    secondary_content: z.array(contentElementSchema).nullish(),
    table_content: z.array(contentElementSchema).nullish(),
    main_topic: z.array(topicSchema).nullish(),
    page_as_markdown: z.string().nullish(),
  })
  .passthrough();

const resultSchema = z
  .object({
    items_count: z.number().nullish(),
    items: z
      .array(
        z
          .object({
            type: z.string().nullish(),
            status_code: z.number().nullish(),
            page_content: parsedPageSchema.nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

type ContentElement = z.infer<typeof contentElementSchema>;
type Topic = z.infer<typeof topicSchema>;

/** One heading in the page's structure. */
type ParsedHeading = {
  title: string;
  /**
   * HTML level as a number, or `null` when the vendor sent neither.
   *
   * **Coerced deliberately.** The vendor sends a string, and a consumer sorting
   * or comparing levels as-is gets `"10" < "2"` — lexicographically true,
   * structurally absurd. A rubric that reports "your H2s come after your H10s"
   * because of a sort is worse than not reporting it.
   */
  level: number | null;
  author: string | null;
  language: string | null;
};

/**
 * A parsed page.
 *
 * **No `schemaTypes` field**, by design — see the module note. Absent is a
 * different claim from null, and a citability consumer needs the difference.
 *
 * Module-private: the metered client's inferred types carry these, and knip
 * enforces that an export nobody names is a lie about the API surface.
 */
type ContentParsingResult = {
  /** The page's heading structure, in the vendor's own topic order. */
  headings: ParsedHeading[];
  /** Primary-content text, concatenated in order. Empty when there was none. */
  primaryText: string;
  /** Outbound links in primary content, deduplicated by URL, first anchor wins. */
  links: Array<{ url: string; anchor: string }>;
  /** The page as markdown, or `null` when `markdownView` was not requested. */
  markdown: string | null;
  /** Items the vendor returned. `0` is a real answer: the task had no result row. */
  itemsCount: number | null;
};

/**
 * Post an `on_page` task with content parsing enabled, and return its id.
 *
 * **The POST is the expensive half** — a real crawl at the base page price plus
 * whatever the task loaded. Deliberately not called from anything that runs
 * per-URL over a large site unless the caller has decided that.
 */
export async function postOnPageTaskForContentParsing(input: {
  url: string;
}): Promise<DataforseoApiResponse<{ taskId: string; url: string }>> {
  const url = input.url.trim();
  if (url.length === 0) {
    throw new AppError("VALIDATION_ERROR", "url is required");
  }

  const response = await dataforseoPost<DataforseoTaskLike & { id?: string }>(
    TASK_POST_PATH,
    // **`enable_content_parsing` is unconditional.** It defaults to `false`, and
    // a task posted without it yields no parseable body — so the id would be
    // perfectly valid and the read that followed it would fail. Sent on every
    // post so no caller can forget the one flag that makes the pair work.
    [{ url, enable_content_parsing: true }],
    // Billed on acceptance. A 5xx coming back does not prove the provider skipped
    // the charge, so replaying it would bill one crawl twice.
    NO_RETRY_BILLED_POST,
  );

  // `okTaskStatusCode: 20100` because a POST answers "Task Created", not 20000.
  // `assertOk` also rejects a **40501 entry inside a 20000 envelope** — the
  // documented shape for an invalid field — and accepting the id there would hand
  // back a task that does not exist, spending a second charge discovering it.
  const task = assertOk(response, {
    classify: classifyOnPageError,
    classifyPath: TASK_POST_PATH,
    okTaskStatusCode: 20100,
  });

  const id = task.id;
  if (typeof id !== "string" || id.length === 0) {
    // A post with no id stored nothing, so there is nothing to read. Failing here
    // tells the caller the post failed instead of surfacing a 40501 on the read.
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO task_post returned no task id, so there is no page to parse",
    );
  }

  return { data: { taskId: id, url }, billing: buildTaskBilling(task) };
}

/**
 * Read the parsed content of a posted `on_page` task.
 *
 * Billed separately from the post that created it, which is why this is metered
 * rather than treated as a free collection read.
 */
export async function fetchOnPageContentParsing(input: {
  taskId: string;
  /** Ask for `page_as_markdown`. Off by default: it is a large field and most
   *  callers want the structure, not the source. */
  markdownView?: boolean;
}): Promise<DataforseoApiResponse<ContentParsingResult>> {
  const taskId = input.taskId.trim();
  if (taskId.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "task_id is required. Post an on_page task with enable_content_parsing first.",
    );
  }

  const response = await dataforseoPost(
    CONTENT_PARSING_PATH,
    [{ id: taskId, markdown_view: input.markdownView ?? false }],
    // Billed on acceptance, same reasoning as the post above.
    NO_RETRY_BILLED_POST,
  );

  const task = assertOk(response, {
    classify: classifyOnPageError,
    classifyPath: CONTENT_PARSING_PATH,
  });

  const raw = resultSchema.safeParse(task.result?.[0]);
  if (!raw.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO on_page/content_parsing returned an unexpected payload",
    );
  }

  const page = raw.data.items?.[0]?.page_content ?? null;
  const primary = page?.primary_content ?? [];

  return {
    data: {
      headings: toHeadings(page?.main_topic ?? []),
      primaryText: joinText(primary),
      links: dedupeLinks(primary),
      markdown: page?.page_as_markdown ?? null,
      itemsCount: raw.data.items_count ?? null,
    },
    billing: buildTaskBilling(task),
  };
}

function toHeadings(topics: Topic[]): ParsedHeading[] {
  return topics.map((topic) => ({
    title: topic.h_title ?? topic.main_title ?? "",
    level: toLevel(topic.level),
    author: topic.author ?? null,
    language: topic.language ?? null,
  }));
}

function toLevel(level: string | number | null | undefined): number | null {
  if (typeof level === "number") return Number.isFinite(level) ? level : null;
  if (level === null || level === undefined) return null;
  const parsed = Number(level);
  // `NaN` becomes `null` rather than a heading that claims to be at level NaN.
  return Number.isFinite(parsed) ? parsed : null;
}

function joinText(elements: ContentElement[]): string {
  return elements
    .map((element) => element.text ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function dedupeLinks(
  elements: ContentElement[],
): Array<{ url: string; anchor: string }> {
  const links: Array<{ url: string; anchor: string }> = [];
  const seen = new Set<string>();
  for (const element of elements) {
    for (const link of element.urls ?? []) {
      const url = link.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      links.push({ url, anchor: link.anchor_text ?? url });
    }
  }
  return links;
}
