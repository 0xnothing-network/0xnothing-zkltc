#!/usr/bin/env bash
# Steps 4-5 of the pipeline ONLY: typecheck + build the extension dist.
#
# Deliberately does NOT run forge test or the deploy again: the factory is
# already live on LiteForge and pinned in .env.local, and re-running
# DeployFactory would burn gas to mint a SECOND, unrelated factory address
# (breaking every wallet address already predicted from the first one).
# Use finish.sh for a from-scratch run against a fresh chain.
set -euo pipefail

ROOT="c:/Users/tdat/Desktop/0xnothing/0xNothing-zkLTC-Testnet"
QW="$ROOT/quantum-wallet"
WALLET="$ROOT/apps/wallet"

# Re-pin the already-deployed factory (idempotent). PRIVATE_KEY is sourced into
# this shell only to keep .env.local a single file; it is dropped immediately
# below so it never reaches the npm child processes or any build log.
set -a
# shellcheck disable=SC1091
. "$QW/.env.local"
set +a
echo "VITE_QUANTUM_FACTORY=$QW_FACTORY" > "$WALLET/.env.local"
unset PRIVATE_KEY
echo "factory wired: $QW_FACTORY"

echo "== [1/3] typecheck the extension (wallet src + quantum SDK src) =="
( cd "$WALLET" && npm run typecheck )

echo "== [2/3] typecheck the relayer =="
# The relayer runs under --experimental-strip-types, which STRIPS types without
# checking them, and its tests import modules rather than executing main(). So a
# missing import on the startup path (e.g. `dirname` used but never imported)
# survives every test and only explodes when the server is actually launched.
# This step is the only thing that checks it.
( cd "$QW/relayer" && npm run typecheck )

echo "== [3/3] build the extension dist =="
( cd "$WALLET" && npm run build )

echo ""
echo "DONE."
echo "  factory : $QW_FACTORY"
echo "  dist    : $WALLET/dist"
echo "  relayer : cd $QW/relayer && npm start   (gas sponsor on 127.0.0.1:8787)"
echo "  load    : chrome://extensions -> Developer mode -> Load unpacked -> $WALLET/dist"
