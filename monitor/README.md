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

