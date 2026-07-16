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
  "parentCommit": "<sha-do-pai-do-commit-do-receipt>",
  "treeScope": "cartorio.git-tree.v1:app-files-excluding-mission-receipts",
  "treeHashExcludingReceipts": "<sha256>",
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
- `GIT_CONTEXT_MISSING`: comando `entregar` precisa de um repo git para resolver artefatos por blob.
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
  "parentCommit": "<sha-do-pai-do-commit-atual>",
  "treeScope": "cartorio.git-tree.v1:app-files-excluding-mission-receipts",
  "treeHashExcludingReceipts": "<sha256>",
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

### Digest canonico da arvore

`treeScope = cartorio.git-tree.v1:app-files-excluding-mission-receipts`.

No required check remoto, o escopo e a arvore Git do app no commit verificado. Em monorepo, o app e
o `--app-dir` passado ao verificador; sem `--app-dir`, e a raiz do repo. O digest e reconstruido
somente a partir de objetos Git versionados no commit:

1. listar todos os arquivos rastreados sob o escopo com `git ls-tree -r --name-only`;
2. converter cada caminho para relativo ao escopo;
3. excluir apenas caminhos que casem com `.cartorio/missoes/*.receipt.json`;
4. para cada arquivo restante, ler o blob do commit e calcular `sha256` dos bytes do conteudo;
5. montar a lista `[{ "path": "<relativo>", "blobSha256": "<sha256>" }]`;
6. ordenar por `path` em ordem lexicografica deterministica;
7. serializar a lista com JSON canonico do Cartorio e calcular `sha256` UTF-8 dessa serializacao.

O receipt assina esse `treeHashExcludingReceipts` junto com `parentCommit`. Assim o arquivo de
receipt pode entrar no commit atual sem autorreferencia: ele nao assina o hash do commit atual, e sim
o pai exato e todo o conteudo efetivo do commit excluindo somente receipts de missao.

### Break-glass remoto

Break-glass vive em `.cartorio/break-glass/<id>.json` e e artefato posterior. O campo `commit`
assinado aponta para o commit socorrido, nao para o commit que contem o break-glass. O required check
valida assinatura por role `break-glass`, expiry contra a hora observada, blobs no commit alvo e
single-use do `id` no historico alcancavel. Sucesso de break-glass sempre sai como
`break-glass-valid` com marca explicita de excecao.
