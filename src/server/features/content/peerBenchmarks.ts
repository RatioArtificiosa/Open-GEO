/**
 * Peer Benchmarks (CL-720): category percentiles from aggregated distributions.
 *
 * No industry-average endpoint exists, so the benchmark is computed: for each
 * metric, where the subject falls among its peers. Percentiles are honest
 * only with a stated peer set — a percentile over three peers is a ranking
 * wearing statistics' clothes, so under eight peers the answer is unknown,
 * not a number. Every figure carries its n.
 *
 * Pure: distributions arrive as arguments from reads the caller already made.
 */

export type PeerBenchmarkInput = {
  /** Peer values for one metric, subject included or not — stated, not assumed. */
  peers: number[];
  /** The subject's own value on the same metric and unit. */
  subject: number;
  /** Whether the subject is already counted inside `peers`. */
  subjectIncluded: boolean;
};

export type PeerBenchmark = {
  /** 0–100: share of peers at or below the subject. Null when unmeasurable. */
  percentile: number | null;
  peers: number;
  reason: string;
};

/** Below this many peers a percentile is a ranking, not a statistic. */
export const PEER_BENCHMARK_MIN_PEERS = 8;

/**
 * Rank one subject against its peers.
 *
 * Ties count for the subject (at-or-below): a value equal to the best peer
 * observed is the top of the observed range, not second place by
 * philosophical objection. An empty peer set with the subject included still
 * has one observation — itself — and reports 100 with the n visible.
 */
export function peerBenchmark(input: PeerBenchmarkInput): PeerBenchmark {
  const peers = input.subjectIncluded
    ? input.peers
    : [...input.peers, input.subject];
  if (peers.length < PEER_BENCHMARK_MIN_PEERS) {
    return {
      percentile: null,
      peers: peers.length,
      reason: `only ${peers.length} peers — below the ${PEER_BENCHMARK_MIN_PEERS} minimum, so no percentile`,
    };
  }
  const atOrBelow = peers.filter((value) => value <= input.subject).length;
  return {
    percentile: Math.round((atOrBelow / peers.length) * 100),
    peers: peers.length,
    reason: `${atOrBelow} of ${peers.length} peers at or below ${input.subject}`,
  };
}
