# Deploy Ubuntu

Este documento prepara o modulo [notificador/monitor](../README.md) para copia e teste manual em uma VPS Ubuntu, sem instalar servicos automaticamente e sem interferir nos robos da Radio Cabrito.

## Objetivo desta etapa

- Copiar o modulo para a VPS.
- Instalar dependencias do Node.js no proprio modulo.
- Garantir que ffmpeg e ffprobe estejam disponiveis no PATH.
- Rodar o check manualmente, uma vez por execucao.
- Validar o JSON final, o summary e o exit code.

Nao faz parte desta etapa:

- criar backend
- criar PWA
- criar push notification
- criar banco
- reiniciar ou alterar robos
- habilitar systemd em producao continua

## Pre-requisitos na VPS

Confirme estes itens no Ubuntu:

- Node.js
- npm
- ffmpeg e ffprobe
- acesso a internet para consultar os streams
- curl

Exemplo de verificacao:

```bash
node -v
npm -v
ffmpeg -version
ffprobe -version
curl --version
```

## Instalar Node.js e npm no Ubuntu

Este modulo exige Node.js 20 ou superior. Se a VPS ainda nao tiver uma versao compativel, rode depois nela:

```bash
sudo apt update
sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Depois confirme:

```bash
node -v
npm -v
```

## Instalar ffmpeg no Ubuntu

Nao execute isso neste workspace local. Rode apenas depois, na VPS Ubuntu:

```bash
sudo apt update && sudo apt install -y ffmpeg
```

O pacote ffmpeg tambem entrega o binario ffprobe no Ubuntu.

## Copiar a pasta para a VPS

Escolha um diretorio isolado dos robos. Exemplo:

```bash
mkdir -p ~/radio-cabrito
```

Copiando a pasta inteira a partir da maquina local:

```bash
scp -r ./notificador/monitor usuario@IP_DA_VPS:~/radio-cabrito/
```

Alternativa com rsync:

```bash
rsync -av ./notificador/monitor/ usuario@IP_DA_VPS:~/radio-cabrito/monitor/
```

Depois, na VPS:

```bash
cd ~/radio-cabrito/monitor
```

## Instalar dependencias

Preferencialmente:

```bash
npm ci
```

Se necessario:

```bash
npm install
```

## Validar o modulo antes de testar stream

Na VPS, dentro de [package.json](../package.json), rode:

```bash
npm run check
npm run build
```

## Configurar .env

Copie o exemplo Ubuntu e ajuste no proprio diretorio do monitor:

```bash
cp .env.ubuntu.example .env
```

O arquivo .env deve permanecer em formato compativel com bash porque o script de teste faz source dele antes de chamar a CLI.

O arquivo [.env.ubuntu.example](../.env.ubuntu.example) ja inclui os 3 streams reais independentes:

- geral / tudo: https://scrc.radiocabrito.com:13386/;
- modao: https://scrc.radiocabrito.com:14054/;
- festa / universitario: https://scrc.radiocabrito.com:13542/;

As configuracoes de exemplo para VPS deixam o check mais tolerante para teste manual:

- PUBLIC_LISTENER_DEBUG=true
- PUBLIC_LISTENER_SAMPLE_DURATION_SECONDS=20
- PUBLIC_LISTENER_SILENCE_THRESHOLD_DB=-45
- PUBLIC_LISTENER_CONTINUOUS_SILENCE_SECONDS=12
- PUBLIC_LISTENER_TOTAL_TIMEOUT_MS=30000
- PUBLIC_LISTENER_REQUIRE_TLS=true
- PUBLIC_LISTENER_FFMPEG_PATH=ffmpeg
- PUBLIC_LISTENER_FFPROBE_PATH=ffprobe

## Testar manualmente a CLI com os 3 streams

Opcao 1, usando o script seguro de execucao unica:

```bash
chmod +x scripts/run-public-listener-once.sh
./scripts/run-public-listener-once.sh
```

Opcao 2, chamando a CLI diretamente:

```bash
node dist/cli.js
```

Opcao 3, forcando o JSON de targets na linha de comando:

```bash
node dist/cli.js --targets-json '[
  {"id":"geral","name":"Geral / Tudo","url":"https://scrc.radiocabrito.com:13386/;"},
  {"id":"modao","name":"Modao","url":"https://scrc.radiocabrito.com:14054/;"},
  {"id":"festa","name":"Festa / Universitario","url":"https://scrc.radiocabrito.com:13542/;"}
]'
```

O script [scripts/run-public-listener-once.sh](../scripts/run-public-listener-once.sh):

- carrega .env se existir
- executa uma unica vez
- imprime o JSON retornado pela CLI
- devolve o mesmo exit code da CLI
- nao reinicia servicos
- nao mexe nos robos

## Como interpretar summary.overallStatus

No modo multi-stream, a saida final inclui summary:

- healthy: todos os canais ficaram healthy
- degraded: pelo menos um canal falhou e pelo menos um canal ficou healthy
- failed: todos os canais falharam

Os contadores ajudam a leitura:

- healthyCount: quantidade de canais saudaveis
- failedCount: quantidade de canais que nao ficaram healthy
- totalCount: total de canais processados

## Como interpretar o status de cada canal

Cada item de results preserva os status ja definidos pela CLI:

- healthy: stream audivel
- dns_failed: falha ao resolver DNS
- tls_failed: falha de TLS
- connect_failed: falha de conexao
- http_failed: erro HTTP no endpoint
- no_audio_bytes: nenhum byte de audio util recebido
- decode_failed: ffmpeg nao conseguiu decodificar a amostra
- silent: audio com silencio continuo acima do limite configurado
- stalled: stream conectou, mas travou sem progresso suficiente
- timeout: o check excedeu o tempo limite
- unknown_error: erro inesperado

## Como validar o exit code

Depois da execucao, confira o codigo de saida:

```bash
echo $?
```

Regra atual:

- 0: todos os canais ficaram healthy
- 1: um ou mais canais falharam

## Como ver logs

No teste manual mais simples, o proprio stdout e o log principal:

```bash
./scripts/run-public-listener-once.sh | tee monitor-output.json
```

Se futuramente o template de systemd for usado apenas para testes controlados, os logs podem ser vistos com:

```bash
journalctl -u notificador-monitor.service -n 100 --no-pager
```

## Como nao mexer nos robos durante o teste

- Trabalhe somente dentro do diretorio copiado de [notificador/monitor](../README.md).
- Nao execute instaladores ou scripts em outras pastas da Radio Cabrito.
- Nao edite ou reinicie processos dos robos existentes.
- Nao habilite o exemplo de systemd automaticamente.
- Execute apenas testes manuais e de curta duracao nesta etapa.

## Templates de systemd

Foram incluidos apenas como referencia futura:

- [deploy/notificador-monitor.service.example](../deploy/notificador-monitor.service.example)
- [deploy/notificador-monitor.timer.example](../deploy/notificador-monitor.timer.example)

Esses arquivos sao exemplos e nao devem ser instalados nem ativados automaticamente nesta etapa.

Se no futuro voce usar o template de service, alinhe o caminho e o usuario do arquivo .service com o mesmo diretorio escolhido para copiar o modulo.
