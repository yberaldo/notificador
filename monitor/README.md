# public-listener-check

CLI local para simular um ouvinte real acessando a URL publica do stream da Radio Cabrito.

Ela valida DNS, conexao HTTP/HTTPS, TLS quando aplicavel, tenta abrir o stream com ffprobe, decodifica uma amostra curta com ffmpeg e usa silencedetect para detectar silencio continuo.

## Requisitos

- Node.js 20+
- ffmpeg e ffprobe instalados, ou caminhos configurados por variaveis de ambiente.

## Uso single-stream

Modo compativel com a versao atual, usando uma unica URL em PUBLIC_LISTENER_URL ou --url.

```bash
npm install
npm run build
PUBLIC_LISTENER_URL="https://scrc.radiocabrito.com:13386/;" node dist/cli.js
```

Durante desenvolvimento:

```bash
npm run dev -- --url "https://scrc.radiocabrito.com:13386/;" --debug
```

Nesse modo a CLI imprime um unico objeto JSON de diagnostico e retorna exit code 0 somente quando o status final e healthy.

## Uso multi-stream

Quando PUBLIC_LISTENER_TARGETS_JSON ou --targets-json estiver presente, a CLI entra em modo multi-stream, executa os checks em sequencia e imprime um unico JSON final com summary e results.

Os players geral, modao e festa/universitario sao streams independentes.

Exemplo via variavel de ambiente:

```bash
PUBLIC_LISTENER_TARGETS_JSON='[
	{
		"id": "geral",
		"name": "Geral / Tudo",
		"url": "https://scrc.radiocabrito.com:13386/;"
	},
	{
		"id": "modao",
		"name": "Modao",
		"url": "https://scrc.radiocabrito.com:14054/;"
	},
	{
		"id": "festa",
		"name": "Festa / Universitario",
		"url": "https://scrc.radiocabrito.com:13542/;"
	}
]' node dist/cli.js
```

Exemplo equivalente via argumento CLI:

```bash
node dist/cli.js --targets-json '[
	{
		"id": "geral",
		"name": "Geral / Tudo",
		"url": "https://scrc.radiocabrito.com:13386/;"
	},
	{
		"id": "modao",
		"name": "Modao",
		"url": "https://scrc.radiocabrito.com:14054/;"
	},
	{
		"id": "festa",
		"name": "Festa / Universitario",
		"url": "https://scrc.radiocabrito.com:13542/;"
	}
]'
```

O modo multi reutiliza os mesmos timeouts, thresholds e caminhos de ffmpeg/ffprobe definidos para o check single. Se PUBLIC_LISTENER_TARGETS_JSON estiver presente, PUBLIC_LISTENER_URL deixa de controlar a execucao agregada.

## Summary no modo multi

O campo summary resume o estado final do lote:

- overallStatus = healthy quando todos os canais estiverem healthy.
- overallStatus = degraded quando ao menos um canal falhar e ao menos um canal estiver healthy.
- overallStatus = failed quando todos os canais falharem.
- healthyCount informa quantos canais ficaram healthy.
- failedCount informa quantos canais nao ficaram healthy.
- totalCount informa quantos canais foram processados.

O exit code e 0 somente quando todos os canais estiverem healthy. Se um ou mais canais falharem, a CLI encerra com 1.

## Camada local de incidentes

Sem alterar o check principal, a CLI agora faz um pos-processamento local do diagnostico e persiste um snapshot em [data/incidents-state.json](data/incidents-state.json).

Os eventos notificaveis calculados em notifiableEvents tambem passam por um outbox local persistente em [data/notifiable-events-outbox.json](data/notifiable-events-outbox.json).

Se PUBLIC_LISTENER_INCIDENT_STATE_PATH estiver definida, a CLI usa exatamente esse caminho como arquivo de estado. Se o valor for relativo, ele e resolvido a partir do diretorio corrente de execucao da CLI. Se a variavel nao estiver definida, o comportamento padrao continua igual em producao: [data/incidents-state.json](data/incidents-state.json).

Se PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH estiver definida, a CLI usa exatamente esse caminho como arquivo de outbox. Se o valor for relativo, ele tambem e resolvido a partir do diretorio corrente de execucao da CLI. Se a variavel nao estiver definida, o comportamento padrao continua igual em producao: [data/notifiable-events-outbox.json](data/notifiable-events-outbox.json).

- o estado e snapshot, nao log infinito
- a pasta data e criada automaticamente quando necessario
- a escrita usa arquivo temporario, rename e backup unico em [data/incidents-state.json.bak](data/incidents-state.json.bak)
- o outbox tambem usa snapshot JSON, nao JSONL
- a escrita do outbox usa arquivo temporario, rename e backup unico em [data/notifiable-events-outbox.json.bak](data/notifiable-events-outbox.json.bak)
- o snapshot nao persiste evidence, stderrSnippet nem stdoutSnippet
- targets que nao aparecem mais no diagnostico atual sao removidos do snapshot final sem gerar evento notificavel nessa etapa
- o outbox faz dedupe por dedupeKey
- eventos novos entram com status pending
- nesta etapa nao existe entregador externo; status sent, failed e discarded ficam reservados para a proxima fase
- nao ha poda automatica de pending nesta etapa
- retencao de sent e discarded fica documentada como etapa futura
- ordem critica de persistencia: o outbox e salvo antes do snapshot de incidentes para evitar perder transicoes se a CLI cair entre as duas escritas

## Dispatcher local do outbox

O monitor agora tambem inclui um segundo comando CLI separado para consumir o outbox local sem alterar o fluxo atual do check principal.

Comandos disponiveis:

- bin: radio-cabrito-dispatch-outbox
- npm script: npm run dispatch:outbox
- build final: dist/incidents/dispatch-outbox-cli.js

Nesta fase 1, o dispatcher ainda nao envia nada para fora da VPS. Ele apenas consome o outbox local e executa adapters internos de simulacao.

Comportamento atual do dispatcher:

- usa o mesmo path do outbox ja existente, controlado por PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH
- se a variavel nao estiver definida, continua usando data/notifiable-events-outbox.json
- cria um lock local em <outbox>.lock para impedir dois dispatchers simultaneos
- o lock guarda pid, createdAt e expiresAt
- se um lock valido ja existir, o comando encerra com skippedBecauseLocked = true
- eventos elegiveis sao pending e failed cujo backoff ja venceu
- a ordem de processamento e queuedAt e depois eventId
- antes de chamar o adapter, o dispatcher incrementa attempts, atualiza lastAttemptAt e salva o outbox imediatamente
- se o adapter retornar sucesso, o evento vira sent
- se o adapter retornar erro retryable, o evento vira failed
- se o adapter retornar erro permanente, o evento vira discarded
- se o evento ja tiver atingido o limite de tentativas, ele tambem vira discarded sem nova chamada ao adapter
- nesta fase nao existe status intermediario processing

Adapters disponiveis:

- log: adapter padrao; escreve um resumo do evento no stderr do processo e marca sucesso
- noop: nao entrega nada e so simula sucesso, erro retryable ou erro permanente
- telegram: canal operacional escolhido para notificacoes reais; envia mensagem curta via Telegram Bot API usando sendMessage

Variaveis de ambiente do dispatcher:

- PUBLIC_LISTENER_DISPATCH_ADAPTER=log|noop|telegram
- PUBLIC_LISTENER_DISPATCH_NOOP_MODE=success|retryable_error|permanent_error
- PUBLIC_LISTENER_DISPATCH_LOCK_TTL_MS, padrao 600000
- PUBLIC_LISTENER_DISPATCH_RETRY_BASE_MS, padrao 300000
- PUBLIC_LISTENER_DISPATCH_RETRY_MAX_MS, padrao 21600000
- PUBLIC_LISTENER_DISPATCH_MAX_ATTEMPTS, padrao 10

Variaveis opcionais do adapter Telegram:

- PUBLIC_LISTENER_TELEGRAM_BOT_TOKEN
- PUBLIC_LISTENER_TELEGRAM_CHAT_ID
- PUBLIC_LISTENER_TELEGRAM_API_BASE_URL, padrao https://api.telegram.org
- PUBLIC_LISTENER_TELEGRAM_MESSAGE_PREFIX
- PUBLIC_LISTENER_TELEGRAM_THREAD_ID
- PUBLIC_LISTENER_TELEGRAM_TIMEOUT_MS, padrao 10000

Exemplos:

```bash
npm run dispatch:outbox
```

Para obter JSON puro do dispatcher, prefira executar o binario Node diretamente, sem o cabecalho do npm:

```bash
node dist/incidents/dispatch-outbox-cli.js
```

```bash
PUBLIC_LISTENER_DISPATCH_ADAPTER=noop \
PUBLIC_LISTENER_DISPATCH_NOOP_MODE=retryable_error \
node dist/incidents/dispatch-outbox-cli.js
```

Exemplo de teste do Telegram com outbox temporario:

```bash
PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH=/tmp/notifiable-events-outbox.telegram-test.json \
PUBLIC_LISTENER_DISPATCH_ADAPTER=telegram \
PUBLIC_LISTENER_TELEGRAM_BOT_TOKEN=000000:token-de-teste \
PUBLIC_LISTENER_TELEGRAM_CHAT_ID=-1001234567890 \
PUBLIC_LISTENER_TELEGRAM_MESSAGE_PREFIX="[monitor-vps]" \
node dist/incidents/dispatch-outbox-cli.js
```

O adapter Telegram e o canal operacional escolhido para notificacoes externas deste monitor. O padrao de execucao do dispatcher continua sendo log, entao Telegram so entra em uso quando PUBLIC_LISTENER_DISPATCH_ADAPTER=telegram estiver configurada.

PWA e Web Push sairam do escopo deste monitor. O fluxo operacional de notificacao agora considera apenas Telegram como canal externo.

Mensagem atual do Telegram:

- texto simples, sem parse_mode nesta fase
- informa apenas se o player ficou offline ou voltou online
- usa targetName como nome principal do player; se targetName estiver vazio, cai para targetId
- mantem PUBLIC_LISTENER_TELEGRAM_MESSAGE_PREFIX quando configurado

Exemplo de mensagem para incidente aberto:

```text
[Radio Cabrito]
🚨 PLAYER OFFLINE
Geral / Tudo
```

Exemplo de mensagem para incidente resolvido:

```text
[Radio Cabrito]
✅ PLAYER ONLINE NOVAMENTE
Geral / Tudo
```

Seguranca operacional do Telegram:

- o token nao deve aparecer em logs, erros ou documentacao de execucao
- o dispatcher sanitiza mensagens de erro e nao persiste a URL completa da Bot API
- o token nao entra na mensagem, no JSON final do dispatcher nem no outbox
- nao serialize process.env nem bodies sensiveis em troubleshooting

Semantica atual:

- o dispatcher opera em modelo at-least-once
- se um adapter futuro confirmar envio externo e o processo cair antes de gravar status sent, o mesmo evento pode ser tentado novamente numa rodada futura
- o adapter log e o adapter noop existem exatamente para validar esse fluxo sem disparar notificacoes reais
- o adapter Telegram pode gerar duplicidade visivel ao operador se a mensagem for enviada com sucesso e o processo cair antes de persistir status sent

## Bot Telegram de status sob demanda

O monitor tambem inclui um CLI separado para responder perguntas de status feitas ao bot Telegram.

Comandos disponiveis:

- bin: telegram-status-bot
- npm script: npm run telegram:status-bot
- build final: dist/telegram-status-bot/cli.js

Esse CLI usa Telegram getUpdates com long polling e responde somente ao chat configurado em PUBLIC_LISTENER_TELEGRAM_CHAT_ID. Mensagens de outros chats sao ignoradas silenciosamente e o offset avanca para evitar repeticao.

Comandos aceitos no Telegram:

- /status
- status
- online
- tao online?
- tão online?

Fluxo da resposta:

1. o bot recebe o update autorizado
2. responde imediatamente:

```text
⏳ Checando players agora...
```

3. executa uma nova checagem real dos targets configurados em PUBLIC_LISTENER_TARGETS_JSON
4. responde:

```text
📻 Status dos players
Geral / Tudo: ONLINE
Modao: ONLINE
Festa / Universitario: ONLINE
```

Para cada target, healthy vira ONLINE. Qualquer outro status vira OFFLINE.

Importante: esse comando nao usa [data/incidents-state.json](data/incidents-state.json) como fonte principal do status, nao usa [data/notifiable-events-outbox.json](data/notifiable-events-outbox.json) e nao chama dist/cli.js. Ele reaproveita diretamente a logica real de checagem do public-listener-check.

Variaveis reutilizadas:

- PUBLIC_LISTENER_TELEGRAM_BOT_TOKEN
- PUBLIC_LISTENER_TELEGRAM_CHAT_ID
- PUBLIC_LISTENER_TELEGRAM_API_BASE_URL, padrao https://api.telegram.org
- PUBLIC_LISTENER_TELEGRAM_TIMEOUT_MS, padrao 10000
- PUBLIC_LISTENER_TELEGRAM_THREAD_ID, opcional para grupos com topicos
- PUBLIC_LISTENER_TARGETS_JSON

Variaveis especificas do bot de status:

- PUBLIC_LISTENER_TELEGRAM_STATUS_OFFSET_PATH, padrao data/telegram-status-offset.json
- PUBLIC_LISTENER_TELEGRAM_STATUS_POLL_TIMEOUT_SECONDS, padrao 25
- PUBLIC_LISTENER_TELEGRAM_STATUS_ONCE=true|false, padrao false

Formato do offset:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-07-01T12:00:00.000Z",
  "offset": 123456789
}
```

Na primeira execucao, se o arquivo de offset nao existir, o CLI faz bootstrap seguro: chama getUpdates, nao responde mensagens antigas, grava o maior update_id + 1 e encerra se estiver em modo once.

Exemplo de validacao manual em uma unica rodada:

```bash
PUBLIC_LISTENER_TELEGRAM_STATUS_ONCE=true node dist/telegram-status-bot/cli.js
```

Enquanto uma checagem esta em andamento, outro comando valido recebe:

```text
⏳ Já estou checando os players. Tente novamente em instantes.
```

O token do Telegram nao deve aparecer em logs. Erros que contenham caminhos /bot<TOKEN>/getUpdates ou /bot<TOKEN>/sendMessage sao sanitizados.

Politica atual:

- falhas estruturais locais do monitor abrem com 1 ocorrencia
- falhas criticas de transporte, protocolo, bytes e decode abrem com 2 falhas consecutivas
- silent e stalled abrem com 3 falhas consecutivas
- qualquer incidente resolve com 2 sucessos consecutivos

As falhas estruturais sao detectadas por reason. Nesta etapa, os motivos tratados como estruturais sao:

- missing_stream_url
- unsupported_protocol
- invalid_stream_url
- ffmpeg_not_available
- ffprobe_not_available
- cli_unhandled_error
- tls_required_but_url_is_not_https

## JSON enriquecido

A CLI preserva o JSON atual e adiciona dois campos no topo:

- incidentEvaluation
- notifiableEvents

Formato resumido:

```json
{
	"incidentEvaluation": {
		"schemaVersion": 1,
		"evaluatedAt": "2026-06-29T12:00:00.000Z",
		"checkName": "public-listener-check",
		"checkVersion": "v1",
		"policySnapshot": {
			"structuralOpenThreshold": 1,
			"criticalOpenThreshold": 2,
			"qualityOpenThreshold": 3,
			"resolveAfterConsecutiveSuccesses": 2,
			"structuralReasons": ["missing_stream_url"],
			"qualityStatuses": ["silent", "stalled"]
		},
		"summary": {
			"targetCount": 3,
			"openIncidentCount": 1,
			"openedCount": 1,
			"keptOpenCount": 0,
			"recoveringCount": 0,
			"resolvedCount": 0,
			"noneCount": 2
		},
		"stateStore": {
			"path": "data/incidents-state.json",
			"loadSource": "primary",
			"recoveredFromCorruption": false,
			"loadError": null,
			"writeSucceeded": true,
			"writeError": null
		},
		"outbox": {
			"path": "data/notifiable-events-outbox.json",
			"loadSource": "primary",
			"recoveredFromCorruption": false,
			"loadError": null,
			"queuedCount": 1,
			"duplicateCount": 0,
			"entryCount": 1,
			"writeSucceeded": true,
			"writeError": null
		},
		"targets": [
			{
				"targetId": "geral",
				"targetName": "Geral / Tudo",
				"streamUrl": "https://scrc.radiocabrito.com:13386/;",
				"status": "timeout",
				"reason": "operation_timeout",
				"severity": "critical",
				"failureClass": "critical",
				"structuralFailure": false,
				"transition": "opened",
				"incidentState": "open",
				"incidentId": "geral:2026-06-29T11:58:00.000Z",
				"openedAt": "2026-06-29T12:00:00.000Z",
				"resolvedAt": null,
				"consecutiveFailures": 2,
				"consecutiveSuccesses": 0,
				"openAfterConsecutiveFailures": 2,
				"resolveAfterConsecutiveSuccesses": 2
			}
		]
	},
	"notifiableEvents": [
		{
			"eventId": "incident_opened:geral:2026-06-29T11:58:00.000Z:2026-06-29T12:00:00.000Z",
			"incidentId": "geral:2026-06-29T11:58:00.000Z",
			"targetId": "geral",
			"targetName": "Geral / Tudo",
			"type": "incident_opened",
			"status": "timeout",
			"reason": "operation_timeout",
			"severity": "critical",
			"occurredAt": "2026-06-29T12:00:00.000Z",
			"streakCount": 2,
			"dedupeKey": "incident_opened:geral:2026-06-29T11:58:00.000Z"
		}
	],
	"checkName": "public-listener-check"
}
```

Formato do arquivo de outbox:

```json
{
	"schemaVersion": 1,
	"updatedAt": "2026-06-29T12:00:00.000Z",
	"entries": [
		{
			"dedupeKey": "incident_opened:geral:2026-06-29T11:58:00.000Z",
			"eventId": "incident_opened:geral:2026-06-29T11:58:00.000Z:2026-06-29T12:00:00.000Z",
			"incidentId": "geral:2026-06-29T11:58:00.000Z",
			"targetId": "geral",
			"targetName": "Geral / Tudo",
			"type": "incident_opened",
			"status": "pending",
			"reason": "operation_timeout",
			"severity": "critical",
			"occurredAt": "2026-06-29T12:00:00.000Z",
			"streakCount": 2,
			"queuedAt": "2026-06-29T12:00:01.000Z",
			"updatedAt": "2026-06-29T12:00:01.000Z",
			"lastSeenAt": "2026-06-29T12:00:00.000Z",
			"attempts": 0,
			"lastAttemptAt": null,
			"sentAt": null,
			"discardedAt": null,
			"lastError": null
		}
	]
}
```

Eventos notificaveis nesta etapa:

- incident_opened
- incident_resolved

Quando PUBLIC_LISTENER_INCIDENT_STATE_PATH for usada, incidentEvaluation.stateStore.path passa a refletir o caminho efetivamente resolvido e utilizado pela execucao.

Quando PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH for usada, incidentEvaluation.outbox.path passa a refletir o caminho efetivamente resolvido e utilizado pela execucao.

## Configuracao

Variaveis suportadas:

- PUBLIC_LISTENER_URL
- PUBLIC_LISTENER_TARGETS_JSON
- PUBLIC_LISTENER_INCIDENT_STATE_PATH
- PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH
- PUBLIC_LISTENER_USER_AGENT
- PUBLIC_LISTENER_TOTAL_TIMEOUT_MS
- PUBLIC_LISTENER_SAMPLE_DURATION_SECONDS
- PUBLIC_LISTENER_SILENCE_THRESHOLD_DB
- PUBLIC_LISTENER_CONTINUOUS_SILENCE_SECONDS
- PUBLIC_LISTENER_REQUIRE_TLS
- PUBLIC_LISTENER_FFMPEG_PATH
- PUBLIC_LISTENER_FFPROBE_PATH
- PUBLIC_LISTENER_DEBUG
- PUBLIC_LISTENER_TELEGRAM_STATUS_OFFSET_PATH
- PUBLIC_LISTENER_TELEGRAM_STATUS_POLL_TIMEOUT_SECONDS
- PUBLIC_LISTENER_TELEGRAM_STATUS_ONCE

Argumentos equivalentes simples:

- --url
- --targets-json
- --user-agent
- --timeout-ms
- --sample-duration-seconds
- --silence-threshold-db
- --continuous-silence-seconds
- --require-tls
- --ffmpeg-path
- --ffprobe-path
- --debug

Exemplo de simulacao manual sem tocar no snapshot real do projeto:

```bash
PUBLIC_LISTENER_INCIDENT_STATE_PATH=./tmp/incidents-state.sim.json node dist/cli.js
```

No exemplo acima, ./tmp/incidents-state.sim.json sera resolvido a partir do diretorio corrente de execucao da CLI.

Exemplo equivalente isolando state e outbox em caminhos temporarios:

```bash
PUBLIC_LISTENER_INCIDENT_STATE_PATH=./tmp/incidents-state.sim.json \
PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH=./tmp/notifiable-events-outbox.sim.json \
node dist/cli.js
```

Em Ubuntu ou em qualquer execucao com caminhos absolutos, o valor e usado como veio:

```bash
PUBLIC_LISTENER_INCIDENT_STATE_PATH=/tmp/incidents-state.sim.json \
PUBLIC_LISTENER_INCIDENT_OUTBOX_PATH=/tmp/notifiable-events-outbox.sim.json \
node dist/cli.js
```

## Deploy Ubuntu

Para preparar a instalacao futura em VPS Ubuntu, consulte [docs/DEPLOY_UBUNTU.md](docs/DEPLOY_UBUNTU.md).

## Status

No resultado individual de cada canal, os status possiveis continuam os mesmos:

- healthy
- dns_failed
- tls_failed
- connect_failed
- http_failed
- no_audio_bytes
- decode_failed
- silent
- stalled
- timeout
- unknown_error

## Testes locais da camada de incidentes

Depois de compilar, rode:

```bash
npm run test:incidents
```

Os testes sinteticos cobrem caminho configurado de state store, resolucao de caminho relativo, abertura critica, abertura warning, recuperacao, resolucao, troca de warning para falha critica, limpeza de targets obsoletos e recuperacao de arquivo de estado corrompido.
