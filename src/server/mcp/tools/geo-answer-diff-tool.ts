/**
 * The answer diff, as an MCP tool — CL-210's `geo_answer_diff`.
 *
 * ## Why this is the moat, and why it is the first of the eleven
 *
 * `answerDiff.ts` says it plainly: *"Every competitor can ask a model a question right now and
 * show you the answer. **Nobody else can show you the seventh one.** The diff is not a feature
 * built on top of the archive; it is the only output that is impossible without it."*
 *
 * So of the eleven tools CL-210 names and does not have, this is the one where the capability
 * **already exists** (`diffAnswers`), the data **already exists** (`geo_answers` plus
 * `geo_answer_citations`), and the tool costs **nothing to run** — it reads our own archive,
 * makes no vendor call, and so needs no `dry_run`. It is the right first addition because it is
 * the only one that **cannot spend money**.
 *
 * ## What it deliberately does not say
 *
 * It does not say *why* an answer changed. `diffAnswers` refuses to: models change for
 * reasons we cannot observe, and presenting a citation change as a consequence of something
 * the customer did is the kind of causal claim that makes a customer attribute a loss to their
 * own content. **The tool description has to carry that too**, because an agent will happily
 * invent a reason if the tool does not decline to.
 */
import { z } from "zod";
import { diffAnswers } from "@/server/features/geo/services/answerDiff";
import { GeoService } from "@/server/features/geo/services/GeoService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  findGeoTarget,
  geoDomainSchema,
  geoPlatformSchema,
  metaOnlyOutputFields,
} from "@/server/mcp/tools/geo-shared";

/**
 * Which two answers to compare.
 *
 * **Two explicit dates rather than "the last N",** because the question a customer asks is
 * always about two specific moments — "since last Tuesday" — and a relative default would make
 * the same call return different diffs on different days, which is the opposite of what an
 * archive is for.
 *
 * **At most one may be omitted**, and the omitted one defaults to the newest answer. That is
 * the common case worth one call: "what changed most recently?"
 */
const answerDiffInputSchema = z.object({
  projectId: projectIdSchema,
  domain: geoDomainSchema,
  prompt: z.string(),
  platform: geoPlatformSchema,
  /** The earlier of the two answers, ISO. Omit to diff against the most recent. */
  before: z.string().optional(),
  /** The later, ISO. Omit to use the most recent answer. */
  after: z.string().optional(),
});

type AnswerDiffArgs = z.infer<typeof answerDiffInputSchema>;

/** The output schema — a shape an agent can branch on without parsing the prose. */
const answerDiffOutputSchema = z
  .object({
    ...metaOnlyOutputFields,
    domain: z.string().optional(),
    platform: z.string().optional(),
    prompt: z.string().optional(),
    /** What was compared, so a reader can tell a two-day diff from a two-month one. */
    beforeAt: z.string().optional(),
    afterAt: z.string().optional(),
    changes: z
      .array(
        z
          .object({
            kind: z.enum(["gained", "lost", "moved"]),
            url: z.string(),
            rank: z.number().nullable().optional(),
            from: z.number().nullable().optional(),
            to: z.number().nullable().optional(),
            // **`.passthrough()` on the nested object, because the outer `.passthrough()` does
            // not reach inside an array.** `output-schema-contract.test.ts` caught this on the
            // first run: *"Use z.looseObject() or .passthrough() for these MCP output objects;
            // cached clients must accept added fields."* A client holding a cached schema
            // breaks on a field we add next month, which is the whole reason the gate exists.
          })
          .passthrough(),
      )
      .optional(),
    /** True when the citation sets are identical — an answer worth stating plainly. */
    unchanged: z.boolean().optional(),
    /**
     * Always true, and stated so an agent can check it.
     *
     * **The tool never attributes a change to a cause.** `diffAnswers` refuses to, and an
     * agent handed a list of `lost` citations will otherwise explain them. Carrying the
     * disclaimer in the structured output rather than only the description means it survives
     * an agent that reads the fields and ignores the prose.
     */
    causation: z.literal("not-inferred").optional(),
  })
  .passthrough();

export const getGeoAnswerDiffTool = {
  name: "get_geo_answer_diff",
  config: {
    title: "What changed between two answers",
    description:
      "Compare two archived answers to the same question on one platform: which citations were gained, lost, or moved. " +
      "This is the only output in OpenGeo that cannot be produced without stored history — a competitor can ask a model a question now, but nobody else can show you the seventh answer. " +
      "IT DOES NOT EXPLAIN WHY: models change for reasons we cannot observe, so do not attribute a lost citation to anything the customer did. " +
      "Use it to answer 'is this working?' — a stable citation set is the good outcome, and a lost one is the finding worth acting on. " +
      "Reads the archive, so it costs nothing and returns what was actually recorded.",
    inputSchema: answerDiffInputSchema,
    outputSchema: answerDiffOutputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },

  handler: withMcpProjectAuth(async (args: AnswerDiffArgs, context) => {
    const target = await findGeoTarget(args.projectId, args.domain);
    if (!target) {
      return mcpResponse({
        text: `${args.domain} is not a monitored target in this project.`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
      });
    }

    // The archive for this question, newest first — the same read `get_geo_answer_history`
    // uses, so the two tools cannot disagree about what exists.
    const answers = await GeoService.listAnswerHistory({
      projectId: args.projectId,
      prompt: args.prompt,
      platform: args.platform,
    });

    if (answers.length < 2) {
      // **One capture is not a diff, and saying so is the answer.** Reporting a diff of an
      // answer against itself would produce "unchanged: true" for a target we have never
      // actually watched change, which reads as good news and is an absence of data.
      return mcpResponse({
        text: [
          `Only ${answers.length} archived answer(s) to "${args.prompt}" on ${args.platform}, so there is nothing to compare yet.`,
          "The archive grows with each patrol — check back after the next run.",
        ].join(" "),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
          { domain: target.domain },
        ),
        structuredContent: {
          domain: target.domain,
          platform: args.platform,
          prompt: args.prompt,
        },
      });
    }

    // Resolve the two answers to diff. Defaults to the two most recent, which is the case
    // worth one call; explicit dates are for "since last Tuesday".
    //
    // **`byDate.get()` returns `"" | undefined`** because `args.after && …` on an
    // `string | undefined` narrows to `""` when falsy — so the first version produced a
    // union of every answer row with the empty string and twenty-odd errors. The `??` only
    // covers `undefined`, which is why the `""` half survived it.
    const byDate = new Map<string, (typeof answers)[number]>(
      answers.map((a) => [a.answeredAt, a]),
    );
    // **Length is already checked above** — the `answers.length < 2` guard returns early — so
    // these two are safe to index without a non-null assertion. The first version wrote `!`
    // out of habit and `no-unnecessary-type-assertion` was right: the assertion asserted
    // nothing the compiler was not already certain of.
    const newest = answers[0];
    const previous = answers[1];

    const after = (args.after ? byDate.get(args.after) : undefined) ?? newest;
    // **A supplied `before` that is not in the archive falls back to `previous`**, rather than
    // diffing against the newest and reporting a change that spans the wrong window. Two reads
    // and an explicit answer is cheaper than a diff a reader cannot trust.
    const before =
      (args.before ? byDate.get(args.before) : undefined) ?? previous;

    if (before.id === after.id) {
      return mcpResponse({
        text: `Both dates resolved to the same archived answer (${after.answeredAt}), so there is no diff to report. Pass two different dates, or omit them to compare the two most recent.`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
          { domain: target.domain },
        ),
        structuredContent: {
          domain: target.domain,
          platform: args.platform,
          prompt: args.prompt,
          beforeAt: before.answeredAt,
          afterAt: after.answeredAt,
        },
      });
    }

    // The citations are a separate table, so each side costs one more read. Two is the number
    // this feature exists to make small.
    const [beforeFull, afterFull] = await Promise.all([
      GeoService.getAnswer(args.projectId, before.id),
      GeoService.getAnswer(args.projectId, after.id),
    ]);

    const diff = diffAnswers({
      prompt: args.prompt,
      before: {
        id: before.id,
        answeredAt: before.answeredAt,
        citations: beforeFull.citations.map((c) => ({
          url: c.url,
          rank: c.rank ?? null,
        })),
      },
      after: {
        id: after.id,
        answeredAt: after.answeredAt,
        citations: afterFull.citations.map((c) => ({
          url: c.url,
          rank: c.rank ?? null,
        })),
      },
    });

    const lines = [
      `${args.prompt} — ${args.platform}, comparing ${before.answeredAt} with ${after.answeredAt}:`,
    ];

    if (diff.changes.length === 0) {
      lines.push(
        "  No citation changed. A stable citation set is the good outcome — the model is not drifting on this question.",
      );
    } else {
      // **Lost first, and labelled as the one to act on.** `diffAnswers` weights them
      // differently on purpose, and the order here follows that weight: a lost citation is a
      // regression, a gained one may just be a new result the model had not seen.
      const lost = diff.changes.filter((c) => c.kind === "lost");
      const gained = diff.changes.filter((c) => c.kind === "gained");
      const moved = diff.changes.filter((c) => c.kind === "moved");

      for (const c of lost) {
        lines.push(
          `  LOST  ${c.url} (was rank ${c.rank ?? "unknown"}) — a regression worth acting on`,
        );
      }
      for (const c of moved) {
        lines.push(`  MOVED ${c.url}  rank ${c.from ?? "?"} → ${c.to ?? "?"}`);
      }
      for (const c of gained) {
        lines.push(`  GAINED ${c.url} (now rank ${c.rank ?? "unknown"})`);
      }
      lines.push(
        "  OpenGeo does not know WHY any of this changed. Do not attribute it to the customer's content without other evidence.",
      );
    }

    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/geo`,
        { domain: target.domain },
      ),
      structuredContent: {
        domain: target.domain,
        platform: args.platform,
        prompt: args.prompt,
        beforeAt: before.answeredAt,
        afterAt: after.answeredAt,
        changes: diff.changes,
        unchanged: diff.changes.length === 0,
        causation: "not-inferred" as const,
      },
    });
  }),
};
