import { describe, expect, it } from "vitest";
import { PEER_BENCHMARK_MIN_PEERS, peerBenchmark } from "./peerBenchmarks";

/**
 * Peer Benchmarks (CL-720) + the minimum-peer rule.
 *
 * A percentile without a stated n is a ranking wearing statistics' clothes.
 * Under eight peers the answer is unknown (never a number, never zero), ties
 * count for the subject, and the peer count travels with every figure.
 */

const TEN_PEERS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

describe("peerBenchmark", () => {
  it("ranks the subject with its n attached", () => {
    const result = peerBenchmark({
      peers: TEN_PEERS,
      subject: 55,
      subjectIncluded: false,
    });
    expect(result.percentile).toBe(55);
    expect(result.peers).toBe(11);
    expect(result.reason).toMatch(/6 of 11/);
  });

  it("counts ties for the subject", () => {
    const result = peerBenchmark({
      peers: [10, 20, 30, 40, 50, 60, 70, 100],
      subject: 100,
      subjectIncluded: false,
    });
    expect(result.percentile).toBe(100);
  });

  it("refuses a percentile under the peer minimum", () => {
    const result = peerBenchmark({
      peers: [1, 2, 3],
      subject: 2,
      subjectIncluded: false,
    });
    expect(result.percentile).toBeNull();
    expect(result.peers).toBe(4);
    expect(result.reason).toMatch(/minimum/);
  });

  it("names the minimum as a constant, not a number in the code", () => {
    expect(PEER_BENCHMARK_MIN_PEERS).toBe(8);
  });
});
