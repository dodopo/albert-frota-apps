# Snapshot Schema

Schema version: `orchestration-dashboard.snapshot.v1`

`GET /api/snapshot` returns a point-in-time, best-effort snapshot for the local OpenClaw fleet. The response is intentionally degraded-friendly: every source has its own freshness, and every failed source reports a partial error without failing the whole snapshot.

## Response

```json
{
  "schemaVersion": "orchestration-dashboard.snapshot.v1",
  "generatedAt": "2026-07-11T22:30:00.000Z",
  "refreshInProgress": false,
  "agents": [
    {
      "id": "neo",
      "nome": "Neo",
      "status": "idle",
      "confidence": 0.92,
      "source": "sessions.json",
      "atividade": "sem atividade recente verificada",
      "tempoDecorrido": 127000,
      "ultimaAtividade": "2026-07-11T22:27:53.000Z",
      "idadeDoDado": 4200,
      "parcial": false
    }
  ],
  "spawnsRecentes": [
    {
      "runId": "agent:neo:subagent:5fac3577-fbe2-4f10-97da-f9925fa0ba66",
      "childSessionKey": "agent:neo:subagent:5fac3577-fbe2-4f10-97da-f9925fa0ba66",
      "alvo": "neo",
      "timestamp": "2026-07-11T22:20:00.000Z",
      "proveniencia": "verificada"
    }
  ],
  "cofre": {
    "presenca": "ausente",
    "ultimoUso": "desconhecido"
  },
  "freshness": {
    "agents.neo.sessions": {
      "source": "sessions.json",
      "timestamp": "2026-07-11T22:27:53.000Z",
      "idadeDoDado": 4200,
      "status": "ok"
    },
    "cofre.ps": {
      "source": "ps",
      "timestamp": "2026-07-11T22:30:00.000Z",
      "idadeDoDado": 0,
      "status": "ok"
    }
  },
  "errosParciais": [
    {
      "source": "agents.einstein.sessions",
      "code": "SOURCE_UNAVAILABLE",
      "message": "fonte indisponivel"
    }
  ]
}
```

## Fields

- `schemaVersion`: constant string for this contract: `orchestration-dashboard.snapshot.v1`.
- `generatedAt`: ISO-8601 timestamp for when this payload was assembled. This is not a global freshness claim.
- `refreshInProgress`: `true` when the server returned the last cached snapshot while a single-flight refresh was running.
- `agents`: one entry per known agent.
- `agents[].id`: stable local id. Current MVP ids: `albert`, `zico`, `einstein`, `neo`, `macgyver`.
- `agents[].nome`: display name.
- `agents[].status`: one of `idle`, `working`, `failed`, `unknown`, `stale`.
  - `failed` is used only when the source carries an explicit failure marker such as `failed` or `error`.
  - absence of data must be represented as `unknown` or `stale`, never as `failed`.
- `agents[].confidence`: number from `0` to `1` indicating how directly the status was inferred from allowed local state.
- `agents[].source`: sanitized source label, not a filesystem path.
- `agents[].atividade`: sanitized short summary derived only from metadata, never from message content.
- `agents[].tempoDecorrido`: elapsed milliseconds since the current/last run started, or `null` when unknown.
- `agents[].ultimaAtividade`: ISO-8601 timestamp for the agent source's latest metadata activity, or `null`.
- `agents[].idadeDoDado`: age in milliseconds of the agent source's latest metadata activity, or `null`.
- `agents[].parcial`: optional boolean. `true` means the card is intentionally incomplete. The Albert card is partial because the dashboard runs as `openclaw` and must not read Hermes-owned files.
- `spawnsRecentes`: recent spawn/session provenance feed, derived from `sessions.json` metadata only.
- `spawnsRecentes[].runId`: local run/session key as recorded in the target agent's `sessions.json`.
- `spawnsRecentes[].childSessionKey`: child session key used for provenance checks.
- `spawnsRecentes[].alvo`: target agent id.
- `spawnsRecentes[].timestamp`: ISO-8601 timestamp from target metadata.
- `spawnsRecentes[].proveniencia`: `verificada` or `nao-verificada`.
  - `verificada` means the `childSessionKey` was found in the target agent's `sessions.json`, and that record maps to a session file that exists after safe open/fstat validation. This is the canonical chain.
- `cofre.presenca`: `presente`, `ausente`, or `desconhecido`, collected via process listing only.
- `cofre.ultimoUso`: one of `hoje`, `esta-semana`, `mais-antigo`, `desconhecido`.
- `freshness`: object keyed by source id. Each source reports its own `timestamp`, `idadeDoDado`, and `status`.
- `errosParciais`: sanitized partial failures. A source failure must not abort the full snapshot.

## Prohibited Payload Data

The payload must never include:

- tokens, credentials, API keys, cookies, secrets, or auth material;
- message or conversation contents;
- home paths or absolute paths for other Unix users;
- environment variables;
- raw error objects or stack traces.

All outbound API data and log lines pass through the central redaction module before serialization.
