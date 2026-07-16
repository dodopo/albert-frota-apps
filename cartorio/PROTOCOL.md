# Protocolo CLI -> ledgerd

Contrato do passo 2 para o F1 do Cartorio. Este arquivo define a superficie esperada entre o CLI
`missao` e o daemon `ledgerd`; a implementacao real de UDS, autenticacao de peer, ledger,
canonicalizacao e crypto fica fora deste esqueleto.

## Transporte

- Producao futura: UDS em `/Users/cartorio/run/ledgerd.sock`.
- O componente que aceita a conexao precisa autenticar a credencial do kernel do peer e congelar a
  identidade no inicio da conexao.
- Neste passo: nenhum socket real e aberto.

## Envelope

Toda chamada usa um envelope JSON canonico futuro:

```json
{
  "protocol": "cartorio-cli-ledgerd/v0.2-stub",
  "command": "entregar",
  "idempotencyKey": "missao:<missaoId>:entregar:<uuid-ou-hash>",
  "actorUid": 501,
  "runId": "agent:neo:subagent:<uuid>",
  "payload": {}
}
```

`idempotencyKey` e obrigatoria para comandos que alteram estado. Repetir a mesma chave com o mesmo
payload deve retornar o mesmo resultado; repetir a mesma chave com payload diferente deve gerar
`CONFLICT`.

## Comandos

### `abrir`

Cria a missao no ledger.

Payload minimo futuro:

```json
{
  "missaoId": "F1-...",
  "ator": "openclaw",
  "ts": "2026-07-16T00:00:00.000Z"
}
```

Evento: `missao.aberta`.

### `entregar`

Registra uma entrega associada a `runId` e artefatos.

Payload minimo futuro:

```json
{
  "missaoId": "F1-...",
  "runId": "agent:neo:subagent:<uuid>",
  "commit": "<sha>",
  "artefatos": [
    { "path": "cartorio/PROTOCOL.md", "blobSha256": "<sha256>" }
  ]
}
```

Evento: `missao.entrega_registrada`.

### `coletar`

Registra coleta ou confirmacao de artefatos.

Evento: `missao.coleta_registrada`.

### `status`

Consulta estado de uma missao sem alterar o ledger.

Evento opcional de auditoria local: `missao.status_consultado`.

### `audit`

Executa auditoria local. Verifica receipts, break-glass pendente e proveniencia por `sessions.json`
quando disponivel.

Evento opcional de auditoria local: `missao.audit_executado`.

## Eventos

Evento futuro no ledger JSONL:

```json
{
  "seq": 1,
  "prevHash": "<sha256-ou-null>",
  "eventType": "missao.entrega_registrada",
  "idempotencyKey": "missao:F1:entregar:...",
  "actorUid": 501,
  "atorEfetivo": "openclaw",
  "ts": "2026-07-16T00:00:00.000Z",
  "payload": {}
}
```

## Classes de erro

- `CONFLICT`: conflito de idempotencia ou concorrencia.
- `PERMISSION_DENIED`: UID/GID real do peer nao autorizado, ou ator alegado diverge do peer.
- `INVALID_STATE`: transicao invalida para o estado atual da missao.
- `DAEMON_UNAVAILABLE`: socket/daemon indisponivel ou esqueleto sem daemon real.

Formato de erro:

```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "idempotencyKey reutilizada com payload diferente",
    "details": {}
  }
}
```

## Recibo local

Receipt futuro em `.cartorio/missoes/<missaoId>.receipt.json`:

```json
{
  "version": "cartorio.receipt.v1",
  "missaoId": "F1-...",
  "ledgerHeadHash": "<sha256>",
  "ledgerSeq": 1,
  "commit": "<sha>",
  "artefatos": [
    { "path": "cartorio/PROTOCOL.md", "blobSha256": "<sha256>" }
  ],
  "runId": "agent:neo:subagent:<uuid>",
  "ator": "openclaw",
  "ts": "2026-07-16T00:00:00.000Z",
  "keyId": "<sha256(pub-raw)-truncado>",
  "codeManifestHash": "<sha256>",
  "buildId": "<build-id>",
  "signature": {
    "alg": "ed25519",
    "value": "<base64>"
  }
}
```

O required check remoto deve distinguir `receipt-valid`, `break-glass-valid` e `fail`.
