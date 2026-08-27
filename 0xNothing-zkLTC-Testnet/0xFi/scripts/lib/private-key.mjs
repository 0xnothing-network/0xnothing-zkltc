const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function normalizePrivateKey(value) {
  const rawKey = String(value || "").trim();
  return rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
}

export function resolvePrivateKey({ env = process.env, role = "deployer", warn = console.warn } = {}) {
  if (role !== "deployer" && role !== "keeper") throw new Error("Unsupported wallet role");

  const variable = role === "keeper" ? "KEEPER_PRIVATE_KEY" : "DEPLOYER_PRIVATE_KEY";
  let source = variable;
  let rawKey = env[variable];

  if (role === "deployer") {
    const legacyKey = env.API_KEY;
    if (String(rawKey || "").trim()) {
      if (String(legacyKey || "").trim()) {
        warn?.("API_KEY is ignored because DEPLOYER_PRIVATE_KEY is configured.");
      }
    } else if (String(legacyKey || "").trim()) {
      source = "API_KEY";
      rawKey = legacyKey;
      warn?.("[deprecated] API_KEY is being used as the deployer key; rename it to DEPLOYER_PRIVATE_KEY.");
    }
  }

  const privateKey = normalizePrivateKey(rawKey);
  if (!PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new Error(`${variable} must be a 32-byte hex private key`);
  }
  return { privateKey, source };
}
