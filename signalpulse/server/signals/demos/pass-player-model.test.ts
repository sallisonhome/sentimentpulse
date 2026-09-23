import test from "node:test";
import assert from "node:assert/strict";
import { estimatePassPlayers } from "./pass-player-model";
import type { PassPlayerEvidence } from "./pass-player-evidence";

const appId = "1234";
const now = Date.parse("2026-09-23T15:44:00Z");
const start = Date.parse("2026-09-16T00:00:00Z");
const samples = Array.from({ length: 7 * 48 + 1 }, (_, i) => ({
  capturedAt: new Date(start + i * 30 * 60_000).toISOString(), ccu: 10,
}));
const evidence: PassPlayerEvidence = {
  appId, runtimeAppId: appId,
  runtimeEvidenceUrl: "https://evidence.example/runtime",
  runtimeVerifiedAt: "2026-09-01T00:00:00Z",
  runtimeValidUntil: "2026-12-01T00:00:00Z",
  calibrations: [{
    window: "d7", meanHoursPerPlayer: 2,
    population: "own_pass_online_active_players",
    validFrom: "2026-09-01T00:00:00Z", validUntil: "2026-12-01T00:00:00Z",
    sourceUrl: "https://evidence.example/playtime",
    validationUrl: "https://evidence.example/holdout",
    validatedAt: "2026-09-10T00:00:00Z",
  }],
};

test("own-pass player-hours model qualifies a fully covered calibrated window", () => {
  const result = estimatePassPlayers({ appId, window: "d7", releaseDate: "2020-01-01",
    samples, sharedRuntime: false, evidence, now });
  assert.equal(result.status, "available");
  assert.equal(result.playerHours, 1680);
  assert.equal(result.players, 840);
  assert.equal(result.coveragePercent, 100);
  assert.equal(result.sampleCount, 336);
});

test("missing intervals, shared runtime and absent calibration fail closed", () => {
  assert.equal(estimatePassPlayers({ appId, window: "d7", releaseDate: "2020-01-01",
    samples: samples.filter((_, i) => i < 100 || i > 110), sharedRuntime: false,
    evidence, now }).status, "insufficient_history");
  assert.equal(estimatePassPlayers({ appId, window: "d7", releaseDate: "2020-01-01",
    samples, sharedRuntime: true, evidence, now }).status, "shared_runtime");
  assert.equal(estimatePassPlayers({ appId, window: "d7", releaseDate: "2020-01-01",
    samples, sharedRuntime: false, now }).status, "runtime_unverified");
});

test("parent identity, expired evidence, bad URLs and impossible output fail closed", () => {
  assert.equal(estimatePassPlayers({ appId, window: "d7", releaseDate: "2020-01-01",
    samples, sharedRuntime: false, evidence: { ...evidence, runtimeAppId: "9999" }, now }).status, "runtime_unverified");
  assert.equal(estimatePassPlayers({ appId, window: "d7", releaseDate: "2020-01-01",
    samples, sharedRuntime: false, evidence: { ...evidence, runtimeValidUntil: "2026-09-02T00:00:00Z" }, now }).status, "runtime_unverified");
  assert.equal(estimatePassPlayers({ appId, window: "d7", releaseDate: "2020-01-01",
    samples, sharedRuntime: false, evidence: { ...evidence, runtimeEvidenceUrl: "javascript:alert(1)" }, now }).status, "runtime_unverified");
  const bad = structuredClone(evidence); bad.calibrations[0].meanHoursPerPlayer = 1000;
  assert.equal(estimatePassPlayers({ appId, window: "d7", releaseDate: "2020-01-01",
    samples, sharedRuntime: false, evidence: bad, now }).status, "invalid_calibration");
});

test("lifetime requires a verified release boundary and at least seven complete days", () => {
  assert.equal(estimatePassPlayers({ appId, window: "ltd", releaseDate: null,
    samples, sharedRuntime: false, evidence, now }).status, "insufficient_history");
  assert.equal(estimatePassPlayers({ appId, window: "ltd", releaseDate: "2026-09-20",
    samples, sharedRuntime: false, evidence, now }).status, "insufficient_history");
});

const run = (overrides: Partial<Parameters<typeof estimatePassPlayers>[0]> = {}) =>
  estimatePassPlayers({ appId, window: "d7", releaseDate: "2020-01-01",
    samples, sharedRuntime: false, evidence, now, ...overrides });

test("two daily observations and stale dense observations never qualify", () => {
  assert.equal(run({ samples: [samples[0], samples[48]] }).players, null);
  assert.equal(run({ samples: samples.slice(0, -49) }).status, "insufficient_history");
  assert.equal(run({ samples: samples.map(s => ({ ...s, capturedAt: new Date(Date.parse(s.capturedAt) - 30 * 86400_000).toISOString() })) }).players, null);
});

test("duplicates cannot inflate player-hours, conflicting and invalid samples fail closed", () => {
  assert.equal(run({ samples: [...samples, ...samples] }).players, 840);
  assert.equal(run({ samples: [...samples, { ...samples[10], ccu: 999 }] }).players, null);
  for (const ccu of [NaN, -1, Infinity, 1.5])
    assert.equal(run({ samples: [{ ...samples[0], ccu }, ...samples.slice(1)] }).players, null);
  assert.equal(run({ samples: [...samples, { capturedAt: "invalid", ccu: 10 }] }).players, null);
  assert.equal(run({ truncated: true }).status, "history_too_large");
});

test("missing calibration, wrong window and expired or ambiguous calibration do not fall back", () => {
  assert.equal(run({ evidence: { ...evidence, calibrations: [] } }).status, "calibration_required");
  const wrong = structuredClone(evidence); wrong.calibrations[0].window = "ltd";
  assert.equal(run({ evidence: wrong }).status, "calibration_required");
  const expired = structuredClone(evidence); expired.calibrations[0].validUntil = "2026-09-22T00:00:00Z";
  assert.equal(run({ evidence: expired }).status, "calibration_expired");
  const ambiguous = structuredClone(evidence); ambiguous.calibrations.push(ambiguous.calibrations[0]);
  assert.equal(run({ evidence: ambiguous }).status, "invalid_calibration");
  for (const meanHoursPerPlayer of [0, -1, NaN, Infinity]) {
    const bad = structuredClone(evidence); bad.calibrations[0].meanHoursPerPlayer = meanHoursPerPlayer;
    assert.equal(run({ evidence: bad }).status, "invalid_calibration");
  }
});

test("zero observed activity is not missing history; impossible player counts are withheld", () => {
  const zero = run({ samples: samples.map(s => ({ ...s, ccu: 0 })) });
  assert.equal(zero.players, 0); assert.equal(zero.status, "available");
  const spike = samples.map((s, i) => ({ ...s, ccu: i === 20 ? 1000 : 0 }));
  assert.equal(run({ samples: spike }).status, "invalid_calibration", "model below observed concurrency is not silently floored");
});

test("daily coverage gate catches concentrated gaps even when aggregate exceeds 95 percent", () => {
  const sparse = samples.filter((_, i) => i < 10 || i > 15);
  const result = run({ samples: sparse });
  assert.ok(result.coveragePercent > 95);
  assert.equal(result.status, "insufficient_history");
  const smallGap = run({ samples: samples.filter((_, i) => i !== 10) });
  assert.equal(smallGap.status, "available");
  assert.equal(smallGap.playerHours, 1670, "missing hour not bridged or treated as real zero");
  assert.equal(smallGap.players, 835, "no unapproved extrapolation across missing intervals");
});

test("current partial day, before-period activity and future samples do not add players", () => {
  const extra = [{ capturedAt: new Date(start - 86400_000).toISOString(), ccu: 999999 },
    { capturedAt: "2026-09-23T05:00:00Z", ccu: 999999 },
    { capturedAt: "2026-09-24T00:00:00Z", ccu: 999999 }];
  assert.equal(run({ samples: [...extra, ...samples] }).players, 840);
  assert.equal(run({ releaseDate: "2027-01-01" }).players, null);
  assert.equal(run({ window: "ltd", releaseDate: "2026-02-30" }).players, null);
});
