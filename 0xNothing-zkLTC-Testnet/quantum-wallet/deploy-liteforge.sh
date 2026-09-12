#!/usr/bin/env bash
# Deploy QuantumWalletFactory to the LiteForge testnet (chain 4441), record the
# address to contracts/deployments/4441.json, and pin QW_FACTORY in .env.local.
#
# The dev PRIVATE_KEY is sourced silently from .env.local and NEVER printed,
# echoed, or exported into any log. Only the resulting public factory address is
# shown.
set -euo pipefail

QW="$(cd "$(dirname "$0")" && pwd)"
cd "$QW"

# 1. vm.writeFile does not create directories — ensure the deployments dir exists.
mkdir -p contracts/deployments

# 2. Bring PRIVATE_KEY into the environment without echoing it. Foundry's
#    ScriptBase reads it via vm.envUint("PRIVATE_KEY").
set -a
# shellcheck disable=SC1091
. ./.env.local
set +a

# 3. Broadcast the deploy (script path + foundry.toml live in contracts/).
cd "$QW/contracts"
forge script script/DeployFactory.s.sol:DeployFactory \
  --rpc-url https://liteforge.rpc.caldera.xyz/infra-partner-http \
  --broadcast --slow

# 4. Read the deployed address back (public information).
ADDR="$(node -e "console.log(require('./deployments/4441.json').address)")"
echo "QuantumWalletFactory deployed @ ${ADDR}"

# 5. Pin QW_FACTORY for the relayer + extension builds. The file has no trailing
#    newline, so the append starts with one to avoid gluing onto PRIVATE_KEY.
printf '\nQW_FACTORY=%s\n' "${ADDR}" >> "$QW/.env.local"
echo "QW_FACTORY appended to .env.local"
