const agentsEl = document.querySelector("#agents");
const freshnessEl = document.querySelector("#freshness");
const spawnsEl = document.querySelector("#spawns");
const cofreEl = document.querySelector("#cofre");
const errorsEl = document.querySelector("#errors");
const refreshStateEl = document.querySelector("#refresh-state");
const refreshButton = document.querySelector("#refresh");
const POLL_INTERVAL_MS = 5000;
const ERROR_BACKOFF_MS = 10000;
let pollTimer;
let isLoading = false;

function ms(value) {
  if (value == null) return "desconhecido";
  if (value < 1000) return `${value} ms`;
  const sec = Math.round(value / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.round(min / 60);
  return `${hr} h`;
}

function text(value) {
  return value == null || value === "" ? "desconhecido" : String(value);
}

function cls(status) {
  return ["idle", "working", "failed", "unknown", "stale"].includes(status) ? status : "unknown";
}

function renderAgents(agents) {
  agentsEl.replaceChildren(...agents.map((agent) => {
    const card = document.createElement("article");
    card.className = `card ${agent.parcial ? "partial" : ""}`;
    card.innerHTML = `
      <div class="card-head">
        <h2></h2>
        <span class="status ${cls(agent.status)}"></span>
      </div>
      <p class="activity"></p>
      <div class="facts">
        <div><div class="label">Idade do dado</div><div class="value"></div></div>
        <div><div class="label">Ultima atividade</div><div class="value"></div></div>
        <div><div class="label">Fonte</div><div class="value"></div></div>
        <div><div class="label">Confianca</div><div class="value"></div></div>
      </div>
    `;
    card.querySelector("h2").textContent = agent.nome;
    card.querySelector(".status").textContent = agent.parcial ? "parcial" : agent.status;
    card.querySelector(".activity").textContent = agent.atividade;
    const values = card.querySelectorAll(".value");
    values[0].textContent = ms(agent.idadeDoDado);
    values[1].textContent = text(agent.ultimaAtividade);
    values[2].textContent = text(agent.source);
    values[3].textContent = `${Math.round((agent.confidence || 0) * 100)}%`;
    return card;
  }));
}

function renderFreshness(freshness) {
  const items = Object.entries(freshness || {}).map(([key, value]) => {
    const el = document.createElement("div");
    el.className = "source";
    el.innerHTML = `<div class="label"></div><div class="value"></div><div class="label"></div>`;
    el.children[0].textContent = key;
    el.children[1].textContent = `${text(value.status)} - ${ms(value.idadeDoDado)}`;
    el.children[2].textContent = text(value.timestamp);
    return el;
  });
  freshnessEl.replaceChildren(...items);
}

function renderSpawns(spawns) {
  const items = (spawns || []).map((spawn) => {
    const el = document.createElement("div");
    el.className = "feed-item";
    const tone = spawn.proveniencia === "verificada" ? "ok" : "warn";
    el.innerHTML = `<div><strong></strong><div class="label"></div></div><div></div>`;
    el.querySelector("strong").textContent = `${spawn.alvo} - ${spawn.childSessionKey}`;
    el.querySelector(".label").textContent = text(spawn.timestamp);
    el.children[1].className = tone;
    el.children[1].textContent = spawn.proveniencia;
    return el;
  });
  spawnsEl.replaceChildren(...items);
}

function renderErrors(errors) {
  if (!errors || errors.length === 0) {
    errorsEl.textContent = "Nenhum erro parcial no snapshot atual.";
    return;
  }
  errorsEl.replaceChildren(...errors.map((err) => {
    const p = document.createElement("p");
    p.className = "bad";
    p.textContent = `${err.source}: ${err.code} - ${err.message}`;
    return p;
  }));
}

function render(data) {
  refreshStateEl.classList.remove("failing");
  refreshStateEl.textContent = data.refreshInProgress ? "refresh em andamento" : `schema ${data.schemaVersion}`;
  renderAgents(data.agents || []);
  renderFreshness(data.freshness || {});
  renderSpawns(data.spawnsRecentes || []);
  cofreEl.textContent = `presenca: ${data.cofre?.presenca || "desconhecido"}; ultimo uso: ${data.cofre?.ultimoUso || "desconhecido"}`;
  renderErrors(data.errosParciais || []);
}

function scheduleNextLoad(delay = POLL_INTERVAL_MS) {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = setTimeout(load, delay);
}

async function load() {
  if (isLoading) return;
  isLoading = true;
  refreshButton.disabled = true;
  try {
    const res = await fetch("/api/snapshot", { cache: "no-store" });
    if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
    render(await res.json());
    scheduleNextLoad(POLL_INTERVAL_MS);
  } catch {
    refreshStateEl.classList.add("failing");
    refreshStateEl.textContent = "coleta falhando; nova tentativa em 10 s";
    scheduleNextLoad(ERROR_BACKOFF_MS);
  } finally {
    isLoading = false;
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => {
  clearTimeout(pollTimer);
  load();
});

document.addEventListener("visibilitychange", () => {
  clearTimeout(pollTimer);
  if (!document.hidden) load();
});

load();
