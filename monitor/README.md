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

## Configuracao

Variaveis suportadas:

- PUBLIC_LISTENER_URL
- PUBLIC_LISTENER_TARGETS_JSON
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

