import path from "node:path";
import { safeExistsFile, safeJson, sourceError, withTimeout } from "./safe-read.mjs";

const ROOT = "/Users/openclaw/.openclaw/agents";
const STALE_MS = 15 * 60 * 1000;
const AGENTS = [
  { id: "albert", nome: "Albert", readable: false, partial: true },
  { id: "zico", nome: "Zico", dir: "main" },
  { id: "einstein", nome: "Einstein", dir: "einstein" },
  { id: "neo", nome: "Neo", dir: "neo" },
  { id: "macgyver", nome: "MacGyver", dir: "macgyver" }
];

function asDate(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function newestSession(sessions) {
  let best = null;
  for (const [key, value] of Object.entries(sessions || {})) {
    if (!value || typeof value !== "object") continue;
    const stamp = Number(value.lastInteractionAt || value.updatedAt || value.startedAt || value.sessionStartedAt || 0);
    if (!best || stamp > best.stamp) best = { key, value, stamp };
  }
  return best;
}

function mapStatus(rawStatus, age) {
  const s = String(rawStatus || "").toLowerCase();
  if (["failed", "error"].includes(s)) return "failed";
  if (["running", "working", "in_progress", "active"].includes(s)) return "working";
  if (Number.isFinite(age) && age > STALE_MS) return "stale";
  if (["done", "completed", "success", "idle", "killed", "aborted"].includes(s)) return "idle";
  return "unknown";
}

function activityFor(status, record) {
  const raw = String(record?.status || "unknown").toLowerCase();
  if (status === "working") return "execucao em andamento por metadados locais";
  if (status === "failed") return "falha explicita registrada por metadados locais";
  if (status === "stale") return "metadados locais antigos";
  if (raw === "killed" || raw === "aborted") return "ultima execucao encerrada por metadados locais";
  if (status === "idle") return "sem trabalho ativo verificado";
  return "sem metadados suficientes";
}

async function readAgent(agent, now) {
  if (agent.readable === false) {
    return {
      agent: {
        id: agent.id,
        nome: agent.nome,
        status: "unknown",
        confidence: 0.2,
        source: "ps/sessao externa",
        atividade: "parcial: usuario Unix distinto; sem leitura de arquivos",
        tempoDecorrido: null,
        ultimaAtividade: null,
        idadeDoDado: null,
        parcial: true
      },
      freshness: {
        source: "nao-lido",
        timestamp: null,
        idadeDoDado: null,
        status: "partial"
      },
      spawns: []
    };
  }
  const sourceId = `agents.${agent.id}.sessions`;
  const sessionsPath = path.join(ROOT, agent.dir, "sessions", "sessions.json");
  const sessions = await withTimeout(safeJson(sessionsPath), 700, "SOURCE_TIMEOUT");
  const newest = newestSession(sessions);
  const age = newest ? Math.max(0, now - newest.stamp) : null;
  const status = newest ? mapStatus(newest.value.status, age) : "unknown";
  const started = Number(newest?.value?.startedAt || newest?.value?.sessionStartedAt || 0);
  const agentOut = {
    id: agent.id,
    nome: agent.nome,
    status,
    confidence: newest ? 0.9 : 0.45,
    source: "sessions.json",
    atividade: activityFor(status, newest?.value),
    tempoDecorrido: started > 0 ? Math.max(0, now - started) : null,
    ultimaAtividade: asDate(newest?.stamp),
    idadeDoDado: age,
    parcial: false
  };
  const spawns = [];
  for (const [key, value] of Object.entries(sessions || {})) {
    if (!value || typeof value !== "object") continue;
    const stamp = Number(value.lastInteractionAt || value.updatedAt || value.startedAt || value.sessionStartedAt || 0);
    if (!stamp) continue;
    const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
    const expectedFile = sessionId ? path.join(ROOT, agent.dir, "sessions", `${sessionId}.jsonl`) : "";
    const verified = expectedFile ? await safeExistsFile(expectedFile) : false;
    spawns.push({
      runId: key,
      childSessionKey: key,
      alvo: agent.id,
      timestamp: asDate(stamp),
      proveniencia: verified ? "verificada" : "nao-verificada",
      _sort: stamp
    });
  }
  return {
    agent: agentOut,
    freshness: {
      source: "sessions.json",
      timestamp: asDate(newest?.stamp),
      idadeDoDado: age,
      status: "ok"
    },
    spawns
  };
}

export async function collectAgents(now = Date.now()) {
  const agents = [];
  const spawns = [];
  const freshness = {};
  const errors = [];
  for (const agent of AGENTS) {
    const sourceId = `agents.${agent.id}.sessions`;
    try {
      const result = await readAgent(agent, now);
      agents.push(result.agent);
      freshness[sourceId] = result.freshness;
      spawns.push(...result.spawns);
    } catch (err) {
      errors.push(sourceError(sourceId, err));
      agents.push({
        id: agent.id,
        nome: agent.nome,
        status: "unknown",
        confidence: 0.1,
        source: "sessions.json",
        atividade: "fonte indisponivel",
        tempoDecorrido: null,
        ultimaAtividade: null,
        idadeDoDado: null,
        parcial: true
      });
      freshness[sourceId] = {
        source: "sessions.json",
        timestamp: null,
        idadeDoDado: null,
        status: "error"
      };
    }
  }
  spawns.sort((a, b) => b._sort - a._sort);
  return {
    agents,
    spawns: spawns.slice(0, 20).map(({ _sort, ...spawn }) => spawn),
    freshness,
    errors
  };
}
