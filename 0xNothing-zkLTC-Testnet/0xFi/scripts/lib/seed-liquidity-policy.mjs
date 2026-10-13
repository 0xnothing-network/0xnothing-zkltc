import { getAddress } from "viem";

const WEI_PATTERN = /^[0-9]+$/;

export const DEFAULT_SEED_CORE_NUSD = 2n * 10n ** 18n;
export const DEFAULT_SEED_SYNTH_COLLATERAL_NUSD = 15n * 10n ** 17n;
export const MIN_SEED_WEI = 10n ** 16n;
export const MAX_SEED_WEI = 10_000n * 10n ** 18n;

export function requiredAddress(value, label) {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} is not a valid address`);
  }
}

export function parseWeiAmount(value, { name, defaultValue, min = MIN_SEED_WEI, max = MAX_SEED_WEI }) {
  const candidate = String(value ?? "").trim() || String(defaultValue);
  if (!WEI_PATTERN.test(candidate)) {
    throw new Error(`${name} must be an integer wei amount between ${min} and ${max}`);
  }
  const parsed = BigInt(candidate);
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer wei amount between ${min} and ${max}`);
  }
  return parsed;
}

export function parseSeedAmounts(env = {}) {
  return {
    coreNusd: parseWeiAmount(env.SEED_CORE_NUSD, {
      name: "SEED_CORE_NUSD",
      defaultValue: DEFAULT_SEED_CORE_NUSD,
    }),
    synthCollateralNusd: parseWeiAmount(env.SEED_SYNTH_COLLATERAL_NUSD, {
      name: "SEED_SYNTH_COLLATERAL_NUSD",
      defaultValue: DEFAULT_SEED_SYNTH_COLLATERAL_NUSD,
    }),
  };
}

export function resolveSeedTargets(network) {
  if (Number(network?.chainId) !== 4441) {
    throw new Error(`Seed script expects LiteForge chain 4441, received ${network?.chainId}`);
  }
  const existing = network.existingContracts ?? {};
  const contracts = network.deployment?.contracts ?? {};
  return {
    nusd: requiredAddress(existing.nusd, "NUSD"),
    router: requiredAddress(contracts.dexRouter, "DEX router"),
    wzkLTC: requiredAddress(contracts.wzkLTC, "wzkLTC"),
    ltcOracle: requiredAddress(contracts.ltcOracle, "LTC oracle"),
    btcOracle: requiredAddress(contracts.btcOracle, "BTC oracle"),
    ethOracle: requiredAddress(contracts.ethOracle, "ETH oracle"),
    corePair: requiredAddress(contracts.wzkLtcNusdPair, "wzkLTC/NUSD pair"),
    nbtc: requiredAddress(contracts.nBTC, "nBTC"),
    nbtcVault: requiredAddress(contracts.nBTCVault, "nBTC vault"),
    nbtcPair: requiredAddress(contracts.nBTCNusdPair, "nBTC/NUSD pair"),
    neth: requiredAddress(contracts.nETH, "nETH"),
    nethVault: requiredAddress(contracts.nETHVault, "nETH vault"),
    nethPair: requiredAddress(contracts.nETHNusdPair, "nETH/NUSD pair"),
  };
}

export function pairIsLiquid(reserves) {
  const reserve0 = BigInt(reserves?.[0] ?? 0);
  const reserve1 = BigInt(reserves?.[1] ?? 0);
  return reserve0 > 0n && reserve1 > 0n;
}

export function planLiquiditySeed({ coreLiquid, markets, amounts }) {
  const actions = [{
    id: "wzkLTC/NUSD",
    action: coreLiquid ? "skip" : "seed-native",
    reason: coreLiquid ? "already-liquid" : "empty-pair",
    nusd: amounts.coreNusd,
  }];
  for (const market of markets) {
    if (market.liquid) {
      actions.push({
        id: `${market.symbol}/NUSD`,
        action: "skip",
        reason: "already-liquid",
        nusd: amounts.synthCollateralNusd,
      });
      continue;
    }
    if (!market.vaultActivated || market.mintPaused) {
      actions.push({
        id: `${market.symbol}/NUSD`,
        action: "skip",
        reason: "vault-inactive",
        nusd: amounts.synthCollateralNusd,
      });
      continue;
    }
    actions.push({
      id: `${market.symbol}/NUSD`,
      action: "seed-synth",
      reason: "empty-pair",
      nusd: amounts.synthCollateralNusd,
    });
  }
  return actions;
}

export function seedPlanNeedsBroadcast(actions) {
  return actions.some((action) => action.action !== "skip");
}
