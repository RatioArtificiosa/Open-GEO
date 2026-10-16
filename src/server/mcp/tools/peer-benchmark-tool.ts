import { z } from "zod";
import {
  type PeerBenchmark,
  type PeerBenchmarkInput,
  peerBenchmark,
} from "@/server/features/content/peerBenchmarks";
import {
  type AggregatePersona,
  type AggregatePersonaInput,
  aggregatePersona,
} from "@/server/features/content/personas";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

/**
 * Peer benchmarks + aggregate persona (CL-720, CL-721): category percentiles
 * and audience description from aggregate signals only.
 *
 * Pure computation over supplied distributions — no vendor call, no credits.
 * Percentiles carry their n and refuse below eight peers; personas describe
 * populations with samples, never persons, and shares that cannot sum to a
 * population are refused rather than rendered. One tool for both because they
 * answer one question together: where we stand, and who we stand among.
 */

const benchmarkInputSchema = {
  projectId: projectIdSchema,
  benchmarks: z
    .array(
      z.object({
        metric: z.string().describe("Metric name, e.g. keyword_difficulty."),
        peers: z.array(z.number()).describe("Peer values on the metric."),
        subject: z.number().describe("Our value on the same metric and unit."),
        subjectIncluded: z
          .boolean()
          .describe("Whether peers already includes the subject."),
      }),
    )
    .min(1)
    .describe("One entry per metric to benchmark."),
  persona: z
    .object({
      demography: z.array(z.object({ label: z.string(), share: z.number() })),
      funnelStage: z
        .enum(["informational", "commercial", "transactional"])
        .nullable(),
      serpFeatures: z.array(z.string()),
      sampleSize: z.number().int().nonnegative(),
    })
    .nullable()
    .describe("Aggregate audience signals, or null to skip the persona."),
} as const;

type BenchmarkArgs = z.infer<z.ZodObject<typeof benchmarkInputSchema>>;

export const peerBenchmarkTool = {
  name: "peer_benchmark",
  config: {
    title: "Benchmark against peers and describe the audience",
    description:
      "Ranks our values against peer distributions as percentiles with n attached (under eight peers the answer is unknown, never a number), and optionally builds an aggregate audience persona from already-aggregate shares — populations with samples, never persons. Pure computation over supplied distributions — no vendor call, no credits, nothing to dry-run.",
    inputSchema: benchmarkInputSchema,
    outputSchema: z
      .object({
        benchmarks: z.array(
          z.looseObject({
            metric: z.string(),
            percentile: z.number().nullable(),
            peers: z.number(),
            reason: z.string(),
          }),
        ),
        persona: z
          .looseObject({
            dominantSegment: z.string().nullable(),
            funnelStage: z.string().nullable(),
            readingHabits: z.array(z.string()),
            sampleSize: z.number(),
            caveat: z.string(),
          })
          .nullable(),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: BenchmarkArgs, context) => {
    // Typed by the modules' contracts: a change to either input shape fails
    // this compile rather than arriving as a silent difference between what
    // the tool accepts and what the modules read.
    const benchmarks: ({ metric: string } & PeerBenchmark)[] =
      args.benchmarks.map((entry) => {
        const input: PeerBenchmarkInput = {
          peers: entry.peers,
          subject: entry.subject,
          subjectIncluded: entry.subjectIncluded,
        };
        return { metric: entry.metric, ...peerBenchmark(input) };
      });
    // The schema marks the persona nullable; a missing persona skips it
    // rather than manufacturing one from nothing.
    const personaInput = args.persona ?? null;
    const persona: AggregatePersona | null =
      personaInput === null
        ? null
        : aggregatePersona({
            demography: personaInput.demography,
            funnelStage: personaInput.funnelStage,
            serpFeatures: personaInput.serpFeatures,
            sampleSize: personaInput.sampleSize,
          } satisfies AggregatePersonaInput);
    const lines = benchmarks.map((entry) =>
      entry.percentile === null
        ? `${entry.metric}: unknown — ${entry.reason}.`
        : `${entry.metric}: percentile ${entry.percentile} of ${entry.peers} — ${entry.reason}.`,
    );
    if (persona !== null) {
      lines.push(
        `Audience: ${persona.dominantSegment ?? "no leading segment"} (${persona.sampleSize} measured). ${persona.caveat}`,
      );
    }
    return mcpResponse({
      text: lines.join("\n"),
      structuredContent: { benchmarks, persona },
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
    });
  }),
};
