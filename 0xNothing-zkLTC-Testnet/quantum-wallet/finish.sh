#!/usr/bin/env bash
# 0xQuantum one-shot: test -> deploy -> wire -> build
# Usage (from anywhere):  bash finish.sh
# set -e: a red forge test aborts BEFORE the live deploy (no wasted gas).
set -euo pipefail

ROOT="c:/Users/tdat/Desktop/0xnothing/0xNothing-zkLTC-Testnet"
QW="$ROOT/quantum-wallet"
WALLET="$ROOT/apps/wallet"

echo "== [1/5] forge test (must be 35/35) =="
( cd "$QW/contracts" && forge test )

echo "== [2/5] deploy QuantumWalletFactory to LiteForge (chain 4441) =="
bash "$QW/deploy-liteforge.sh"

echo "== [3/5] wire the deployed factory into the extension build =="
set -a
. "$QW/.env.local"
set +a
echo "VITE_QUANTUM_FACTORY=$QW_FACTORY" > "$WALLET/.env.local"
echo "wired VITE_QUANTUM_FACTORY=$QW_FACTORY"
FACTORY_ADDR="$QW_FACTORY"
unset PRIVATE_KEY

echo "== [4/5] typecheck the extension =="
( cd "$WALLET" && npm run typecheck )

echo "== [5/5] build the extension dist =="
( cd "$WALLET" && npm run build )

echo ""
echo "DONE."
echo "  factory : $FACTORY_ADDR"
echo "  dist    : $WALLET/dist"
echo "  relayer : cd $QW/relayer  then  npm start   (gas sponsor at 127.0.0.1:8787)"
echo "  load    : $WALLET/dist as an unpacked MV3 extension, open the Quantum screen"
