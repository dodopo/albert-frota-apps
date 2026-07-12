# Observatorio da Frota

Dashboard local de observabilidade da frota Albert/OpenClaw. Ele entrega um snapshot periodico e degradavel do estado dos agentes, feed de proveniencia de spawns, sinais do Cofre e freshness por fonte.

A interface e HTML/CSS/JS vanilla, com dark mode por padrao, fallback para tema claro via `prefers-color-scheme`, botao manual de atualizar e auto-refresh a cada 5 segundos. Em falha de coleta, a UI aplica backoff de 10 segundos sem derrubar a pagina.

## Instalacao do Zero

Requisitos:

- macOS com Homebrew.
- Node.js instalado via Homebrew.
- Zero dependencias externas de npm: nao ha `npm install`; o servidor usa apenas Node stdlib e arquivos estaticos locais.

Instale o Node, se necessario:

```sh
brew install node
```

Suba manualmente:

```sh
cd /Users/openclaw/frota-apps/observatorio
node server.mjs
```

O servidor faz bind somente em loopback:

```text
http://127.0.0.1:9127/
```

Endpoint principal:

```text
GET http://127.0.0.1:9127/api/snapshot
```

Contrato versionado:

```text
docs/snapshot-schema.md
```

## Rodar Como Servico

Use `launchd` para manter o Observatorio de pe depois do login do usuario `openclaw`.

Crie o diretorio de logs usado pelo app:

```sh
mkdir -p /Users/openclaw/.openclaw/workspace-neo/orchestration-dashboard/logs
chmod 700 /Users/openclaw/.openclaw/workspace-neo/orchestration-dashboard/logs
```

Crie `~/Library/LaunchAgents/dev.openclaw.observatorio-frota.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.openclaw.observatorio-frota</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/openclaw/frota-apps/observatorio/server.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/openclaw/frota-apps/observatorio</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/openclaw/.openclaw/workspace-neo/orchestration-dashboard/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/openclaw/.openclaw/workspace-neo/orchestration-dashboard/logs/launchd.err.log</string>
</dict>
</plist>
```

Carregue o servico:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.openclaw.observatorio-frota.plist
launchctl enable gui/$(id -u)/dev.openclaw.observatorio-frota
launchctl kickstart -k gui/$(id -u)/dev.openclaw.observatorio-frota
```

Verifique:

```sh
launchctl print gui/$(id -u)/dev.openclaw.observatorio-frota
curl -fsS http://127.0.0.1:9127/api/snapshot
```

## Logs e Rotacao

Log estruturado do app:

```text
/Users/openclaw/.openclaw/workspace-neo/orchestration-dashboard/logs/dashboard.log
```

Rotacao implementada em `lib/logger.mjs`:

- tamanho maximo: `128 KiB`;
- retencao: `3` arquivos rotacionados;
- nomes: `dashboard.log.1`, `dashboard.log.2`, `dashboard.log.3`;
- diretorio com modo `0700`;
- arquivo com modo `0600`.

Os arquivos `launchd.out.log` e `launchd.err.log` capturam stdout/stderr do processo de servico. Eles nao fazem parte da rotacao interna do app.

## Operacao

Restart manual:

```sh
launchctl kickstart -k gui/$(id -u)/dev.openclaw.observatorio-frota
```

Restart sem `launchd`, se estiver rodando em primeiro plano:

```sh
pkill -f "/Users/openclaw/frota-apps/observatorio/server.mjs"
cd /Users/openclaw/frota-apps/observatorio
node server.mjs
```

Quando reiniciar:

- mudancas em `public/index.html`, `public/styles.css` e `public/app.js` nao exigem restart; basta recarregar o navegador;
- mudancas em `server.mjs` ou `lib/*.mjs` exigem restart do processo.

Publicacao via Tailscale Serve e ato humano, nao automacao silenciosa. O app continua fazendo bind em `127.0.0.1:9127`; se for publicado, a pessoa operadora deve executar e revisar o `tailscale serve` conscientemente, apontando para o loopback local.

Exemplo operacional:

```sh
tailscale serve --bg http://127.0.0.1:9127
tailscale serve status
```

Antes de aceitar trafego por um host publicado, confirme que ele esta em `EXPECTED_HOSTS` dentro de `server.mjs`. Hosts aceitos nesta versao:

```text
127.0.0.1:9127
localhost:9127
mac-mini-de-edoardo.tailb4415f.ts.net
```

## Seguranca

Postura do servidor:

- bind exclusivo em `127.0.0.1:9127`;
- apenas metodos `GET` e `HEAD`;
- validacao estrita de `Host` via `EXPECTED_HOSTS`;
- `Origin` externo negado;
- sem CORS;
- `Cache-Control: no-store` em todas as respostas;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`;
- limite de URL: `2048` bytes;
- limite de headers: `50`;
- timeouts curtos de socket/request/headers;
- arquivos estaticos servidos somente de `public/`;
- snapshot com cache single-flight e intervalo minimo de coleta de 5 segundos;
- falhas parciais entram em `errosParciais` e nao derrubam o snapshot inteiro.

Redaction central:

- modulo: `lib/sanitize.mjs`;
- aplicado em respostas JSON e logs;
- remove ou mascara tokens, API keys, secrets, passwords, authorization, cookies, env, conteudo de mensagens/conversas, paths sensiveis e stacks/objetos brutos de erro;
- `jsonSafe()` serializa sempre depois de `sanitize()`.

Schema publico:

- endpoint: `/api/snapshot`;
- versao: `orchestration-dashboard.snapshot.v1`;
- documento: `docs/snapshot-schema.md`;
- payload best-effort com `schemaVersion`, `generatedAt`, `refreshInProgress`, `agents`, `spawnsRecentes`, `cofre`, `freshness` e `errosParciais`.

## Teste Manual

```sh
cd /Users/openclaw/frota-apps/observatorio
/opt/homebrew/bin/node test/redaction.test.mjs
curl -fsS http://127.0.0.1:9127/api/snapshot
curl -fsS "http://127.0.0.1:9127/api/snapshot?simulateBrokenSource=1"
```

O parametro `simulateBrokenSource=1` injeta erro parcial controlado para validar a degradacao do snapshot.

## Proveniencia

Autoria: Neo, sob governanca da frota.

Runs de origem:

- `runId f279a3a4`: MVP do Observatorio da Frota;
- `runId 6e434127`: dark mode e auto-refresh;
- `runId 1a0a41fc`: host `ts.net` em `EXPECTED_HOSTS`.

Origem material declarada:

```text
commit local 7fdb279 no workspace-neo
```
