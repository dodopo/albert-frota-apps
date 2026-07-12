# Correio

Entrada local para renderizar cards de e-mail em texto puro, pronta para colar no Telegram. Esta entrega cobre a superficie de `card-list` e `card` exigida no staging, com fixtures byte a byte e sem segredos.

## Lei do Repo

- Nada de segredos: nao commitar tokens, cookies, refresh tokens, client secrets, dumps de e-mail real ou credenciais.
- Fixture e contrato primeiro: toda saida relevante precisa de fixture esperada byte a byte.
- Operacao local e explicita: os comandos rodam via Node, sem daemon, sem cron e sem envio externo.
- `card-list` e `card` sao texto puro. Nao ha JSON na stdout operacional.
- `card-list --query` executa a fonte Gmail configurada; `--fixture` fica restrito a teste.
- `card-list` lista uma linha por thread, deduplica por `threadId` e grava `state/last-search.json` fora do git.
- `card --select N` usa a ultima busca local. `card --id <id>` seleciona direto pelo fixture.
- `card --raw` mostra corpo bruto para agente. `card --summary "<t>"` renderiza a versao final. `card --omit-body` mostra o aviso.
- Mudanca de contrato exige fixture nova e README atualizado.

## Instalacao do Zero

Requisitos:

- Node.js 20 ou superior.
- Nenhuma dependencia npm externa.

Execute a partir da entrada do staging:

```sh
cd /Users/openclaw/.openclaw/workspace-neo/correio-staging
node gmail.js help
```

Depois rode os testes byte a byte:

```sh
cd /Users/openclaw/.openclaw/workspace-neo/correio-staging/correio
npm test
node bin/gmail.js self-test
```

## Operacao

Listar cards pela fonte Gmail configurada:

```sh
node bin/gmail.js card-list --query "de Joanna · comprovantes"
```

Fixture byte a byte do gabarito oficial F1:

```sh
node bin/gmail.js card-list --fixture fixtures/input/card-list.json --query "de Joanna · comprovantes"
```

Limitar a lista apos deduplicar por thread:

```sh
node bin/gmail.js card-list --fixture fixtures/input/card-list.json --query "de Joanna · comprovantes" --max-results 1
```

Abrir um card diretamente:

```sh
node bin/gmail.js card --fixture fixtures/input/original-title-bold.json
```

Abrir pelo indice da ultima busca:

```sh
node bin/gmail.js card --select 1
```

Renderizar a saida final de um card resumido pelo agente:

```sh
node bin/gmail.js card --fixture fixtures/input/a2-html-sanitized.json --summary "Resumo final"
```

Ver o corpo bruto para o agente:

```sh
node bin/gmail.js card --fixture fixtures/input/a2-html-sanitized.json --raw
```

Executar a validacao byte a byte:

```sh
npm test
node bin/gmail.js self-test
```

## Contrato Original

- `card-list --query <q> [--max-results 3] [--page N]` imprime um eco humanizado, lista numerada, hora em `America/Sao_Paulo`, primeiro nome do remetente e nada de snippet cru.
- Quando nada aparece, a saida e `Nada encontrado para: <eco>`.
- `card --select N | --id <id>` aceita `--raw`, `--summary "<t>"` e `--omit-body`.
- Sem flag, o card sai no formato aprovado: titulo em negrito, data/remetente, e-mail completo na linha 3 e ate tres linhas do corpo limpo.
- A lista aprovada usa `Busca: <q>`, uma linha por item e nao mostra `Página 1`.

## Adendo A1-A10

- A1: MIME vira texto puro, preferindo `text/plain` e limpando HTML quando necessario.
- A2: `body_state` e tratado como `ok`, `empty` ou `unreadable`; o aviso `"(sem corpo legível)"` aparece quando nao ha corpo aproveitavel.
- A3: remetente segue a precedencia display-name -> parte local -> `"(desconhecido)"`; o primeiro nome vem do primeiro token do display-name.
- A4: caracteres que quebram formatacao de Telegram sao escapados no conteudo dinamico; o negrito do titulo continua vindo do codigo.
- A5: titulo da lista corta de forma deterministica com elipse para bater o gabarito oficial; card usa 200 chars em fronteira de palavra.
- A6: datas exibidas em `America/Sao_Paulo`, com fallback UTC-3 se necessario e `"(data desconhecida)"` quando invalida.
- A7: links ficam como texto puro; anexos nao entram no card final aprovado.
- A8: `card-list` deduplica por `threadId` e `state/last-search.json` guarda o indice -> `messageId`.
- A9: NFC normaliza Unicode e remove controles, zero-width e RTL-override.
- A10: `--raw` e para agente, `--summary` e `--omit-body` nao expõem o corpo bruto no card final.

## Fixtures

Entradas:

- `fixtures/input/card-list.json`
- `fixtures/input/original-title-bold.json`
- `fixtures/input/original-metadata-sender.json`
- `fixtures/input/original-three-line-snippet.json`
- `fixtures/input/a1-no-external-client.json`
- `fixtures/input/a2-html-sanitized.json`
- `fixtures/input/a3-delete-confirm.json`
- `fixtures/input/a4-reply-draft.json`
- `fixtures/input/a5-search-scope.json`
- `fixtures/input/a6-expired-state.json`
- `fixtures/input/a7-telegram-escaping.json`
- `fixtures/input/a8-missing-sender.json`
- `fixtures/input/a9-timezone-dst.json`
- `fixtures/input/a10-edge-cases.json`

Saidas esperadas:

- `fixtures/expected/card-list.json`
- `fixtures/expected/O1-title-bold.json`
- `fixtures/expected/O2-metadata-sender.json`
- `fixtures/expected/O4-three-line-snippet.json`
- `fixtures/expected/A1-no-external-client.json`
- `fixtures/expected/A2-html-sanitized.json`
- `fixtures/expected/A3-delete-confirm.json`
- `fixtures/expected/A4-reply-draft.json`
- `fixtures/expected/A5-search-scope.json`
- `fixtures/expected/A6-expired-state.json`
- `fixtures/expected/A7-telegram-escaping.json`
- `fixtures/expected/A8-missing-sender.json`
- `fixtures/expected/A9-timezone-dst.json`
- `fixtures/expected/A10-edge-cases.json`

O teste `test/card-fixtures.test.mjs` compara stdout byte a byte e tambem cobre `--raw`, `--summary`, `--omit-body`, `--select` e `--max-results`.

## Sem Segredos

`gmail-config-exemplo.json` e os fixtures usam apenas dominios `example.test` e texto neutro. Nao ha OAuth, token cache, client secret ou credencial real nesta entrada.

## Proveniencia

Missoes de implementacao no staging:

```text
runId: 7b1e2e50-0b02-4d45-beb0-92e9de7d200b
childSessionKey: agent:neo:subagent:85950413-1b82-4a02-9194-a9b75a38ae40
runId: 08d3c391-eb4a-4a15-a6d3-6322f06551ea
childSessionKey: agent:neo:subagent:faa00a01-aad5-4ecb-a004-c5c92fe79d36
```

Validacao byte a byte executada com sucesso em `npm test` e `node bin/gmail.js self-test`.
