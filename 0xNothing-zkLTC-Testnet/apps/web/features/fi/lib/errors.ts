export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/user rejected|user denied|rejected the request/i.test(message)) {
    return "The wallet request was rejected.";
  }
  if (/insufficient funds/i.test(message)) {
    return "The wallet does not have enough funds for this transaction.";
  }
  if (/execution reverted/i.test(message)) {
    const reason = message.match(/execution reverted(?::| with reason string)?\s*['"]?([^'"\n]+)/i)?.[1];
    return reason ? `Contract reverted: ${reason.trim()}` : "The contract reverted the transaction.";
  }
  if (/chain|network/i.test(message) && /switch|mismatch|unsupported/i.test(message)) {
    return "Switch the wallet to LitVM LiteForge and try again.";
  }
  return message.split("\n")[0] || "The request could not be completed.";
}
