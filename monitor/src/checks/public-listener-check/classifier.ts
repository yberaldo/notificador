import type { PublicListenerResult, PublicListenerStatus } from "./types.js";

interface ClassifyInput {
  status: PublicListenerStatus;
  reason: string;
  message?: string;
}

export function classify(input: ClassifyInput): PublicListenerResult {
  if (input.status === "healthy") {
    return {
      status: "healthy",
      reason: input.reason,
      severity: "none",
      shouldOpenIncident: false,
      requiresConsecutiveFailures: false,
      message: input.message ?? "Stream publico audivel."
    };
  }

  const requiresConsecutiveFailures = input.status === "silent" || input.status === "stalled";
  const severity = requiresConsecutiveFailures ? "warning" : "critical";

  return {
    status: input.status,
    reason: input.reason,
    severity,
    shouldOpenIncident: !requiresConsecutiveFailures,
    requiresConsecutiveFailures,
    message: input.message ?? defaultMessage(input.status)
  };
}

function defaultMessage(status: PublicListenerStatus): string {
  switch (status) {
    case "dns_failed":
      return "Falha ao resolver DNS do host publico do stream.";
    case "tls_failed":
      return "Falha de TLS ao acessar o stream publico.";
    case "connect_failed":
      return "Falha ao conectar ao stream publico.";
    case "http_failed":
      return "Endpoint publico respondeu com erro HTTP.";
    case "no_audio_bytes":
      return "Nenhum byte de audio foi recebido do endpoint publico.";
    case "decode_failed":
      return "Nao foi possivel decodificar uma amostra do stream.";
    case "silent":
      return "Amostra decodificada contem silencio continuo acima do limite configurado.";
    case "stalled":
      return "O stream conectou, mas ficou sem progresso suficiente.";
    case "timeout":
      return "A verificacao excedeu o tempo limite configurado.";
    case "unknown_error":
      return "Erro desconhecido durante a verificacao do stream publico.";
    case "healthy":
      return "Stream publico audivel.";
  }
}
