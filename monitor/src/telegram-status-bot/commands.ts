export function isStatusCommand(text: string | undefined): boolean {
  if (!text) {
    return false;
  }

  const normalized = normalizeCommandText(text);

  return (
    /^\/status(?:@[a-z0-9_]+)?$/.test(normalized) ||
    normalized === "status" ||
    normalized === "online" ||
    normalized === "tao online?"
  );
}

function normalizeCommandText(text: string): string {
  return text
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}
