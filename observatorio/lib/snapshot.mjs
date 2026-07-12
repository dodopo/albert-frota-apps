import { collectAgents } from "./collect-agents.mjs";
import { collectCofre } from "./collect-cofre.mjs";
import { sanitize } from "./sanitize.mjs";

export const SCHEMA_VERSION = "orchestration-dashboard.snapshot.v1";
const MIN_INTERVAL_MS = 5000;
let lastSnapshot = null;
let lastCollectedAt = 0;
let inFlight = null;

function withSimulatedBrokenSource(snapshot) {
  const out = sanitize({
    ...snapshot,
    freshness: {
      ...(snapshot.freshness || {}),
      "simulated.broken": {
        source: "simulado",
        timestamp: null,
        idadeDoDado: null,
        status: "error"
      }
    },
    errosParciais: [
      ...(snapshot.errosParciais || []),
      {
        source: "simulated.broken",
        code: "SIMULATED_SOURCE_ERROR",
        message: "fonte quebrada simulada"
      }
    ]
  });
  return out;
}

async function collectSnapshot({ simulateBrokenSource = false } = {}) {
  const now = Date.now();
  const [agentsResult, cofreResult] = await Promise.all([
    collectAgents(now),
    collectCofre(now)
  ]);
  const errosParciais = [
    ...agentsResult.errors,
    ...cofreResult.errors
  ];
  const freshness = {
    ...agentsResult.freshness,
    ...cofreResult.freshness
  };
  if (simulateBrokenSource) {
    errosParciais.push({
      source: "simulated.broken",
      code: "SIMULATED_SOURCE_ERROR",
      message: "fonte quebrada simulada"
    });
    freshness["simulated.broken"] = {
      source: "simulado",
      timestamp: null,
      idadeDoDado: null,
      status: "error"
    };
  }
  return sanitize({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    refreshInProgress: false,
    agents: agentsResult.agents,
    spawnsRecentes: agentsResult.spawns,
    cofre: cofreResult.cofre,
    freshness,
    errosParciais
  });
}

export async function getSnapshot(options = {}) {
  const now = Date.now();
  if (lastSnapshot && now - lastCollectedAt < MIN_INTERVAL_MS) {
    const snapshot = sanitize({ ...lastSnapshot, refreshInProgress: Boolean(inFlight) });
    return options.simulateBrokenSource ? withSimulatedBrokenSource(snapshot) : snapshot;
  }
  if (inFlight) {
    if (lastSnapshot) {
      const snapshot = sanitize({ ...lastSnapshot, refreshInProgress: true });
      return options.simulateBrokenSource ? withSimulatedBrokenSource(snapshot) : snapshot;
    }
    return inFlight;
  }
  inFlight = collectSnapshot(options).then((snapshot) => {
    lastSnapshot = snapshot;
    lastCollectedAt = Date.now();
    return snapshot;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function resetSnapshotCacheForTest() {
  lastSnapshot = null;
  lastCollectedAt = 0;
  inFlight = null;
}
