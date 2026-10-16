import { z } from "zod";
import {
  type ContentGrade,
  type ContentGradeInput,
  gradeContent,
} from "@/server/features/content/contentGrade";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

/**
 * Grade content (CL-719): read an on-page crawl result aloud, never blended.
 *
 * Pure reading over a supplied crawl result — no vendor call, no credits. The
 * five readability indices run in opposite directions, so they are shown
 * individually with their directions; any average of them would be a number
 * whose direction is meaningless (R14). Density is a ratio, checks are counts.
 */

const gradeInputSchema = {
  projectId: projectIdSchema,
  onpageScore: z
    .number()
    .min(0)
    .max(100)
    .describe("The vendor's onpage_score, 0–100 — never page_score."),
  readability: z
    .object({
      fleschKincaid: z.number().optional(),
      ari: z.number().optional(),
      colemanLiau: z.number().optional(),
      daleChall: z.number().optional(),
      smog: z.number().optional(),
    })
    .describe(
      "Indices present in this crawl; absent ones are omitted, not zeroed.",
    )
    .default({}),
  keywordDensityRatio: z
    .number()
    .nullable()
    .describe("Density as a ratio (0.02, not 2), or null when unreported."),
  checksPassed: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Checks passed, or null."),
  checksTotal: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Checks total, or null."),
} as const;

type GradeArgs = z.infer<z.ZodObject<typeof gradeInputSchema>>;

export const gradeContentTool = {
  name: "grade_content",
  config: {
    title: "Grade a page's content quality",
    description:
      "Reads an on-page crawl result aloud: the vendor's onpage_score passed through with provenance, five readability indices shown individually with their directions (never averaged — Flesch–Kincaid higher means easier while the other four higher means harder), keyword density as a displayed ratio rather than a grade, and summary checks as counts rather than booleans. Pure reading over a supplied crawl — no vendor call, no credits, nothing to dry-run.",
    inputSchema: gradeInputSchema,
    outputSchema: z
      .object({
        score: z.number(),
        scoreSource: z.string(),
        indices: z.array(
          z.looseObject({
            name: z.string(),
            label: z.string(),
            value: z.number(),
            higherMeans: z.string(),
          }),
        ),
        densityPercent: z.number().nullable(),
        densityNote: z.string().nullable(),
        checkCoverage: z.string().nullable(),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: GradeArgs, context) => {
    // Typed by the module's contract: a change to the grade's inputs fails
    // this compile rather than arriving as a silent difference between what
    // the tool accepts and what the module reads.
    const input: ContentGradeInput = {
      onpageScore: args.onpageScore,
      readability: args.readability,
      keywordDensityRatio: args.keywordDensityRatio,
      checksPassed: args.checksPassed,
      checksTotal: args.checksTotal,
    };
    const grade: ContentGrade = gradeContent(input);
    const lines = [
      `On-page score ${grade.score} (${grade.scoreSource}).`,
      ...grade.indices.map(
        (entry) =>
          `${entry.label} ${entry.value} (higher means ${entry.higherMeans}).`,
      ),
    ];
    lines.push(
      grade.densityPercent === null
        ? `Density unmeasured — ${grade.densityNote}.`
        : `Density ${grade.densityPercent}% — ${grade.densityNote}.`,
    );
    lines.push(
      grade.checkCoverage === null
        ? "Check coverage unmeasured — counts not supplied."
        : grade.checkCoverage + ".",
    );
    return mcpResponse({
      text: lines.join("\n"),
      structuredContent: { ...grade },
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
    });
  }),
};
