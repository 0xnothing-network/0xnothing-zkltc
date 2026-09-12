#!/usr/bin/env bash
# One-shot verification for quantum-wallet Phases 0-3. Tolerant: each step runs
# with ';' so a single failure does not stop the rest, and the table at the end
# shows exactly what passed/failed. Run from anywhere:
#   bash quantum-wallet/verify.sh
# (Git Bash / WSL / any POSIX shell.)

set -u
cd "$(dirname "$0")" || exit 1
QW="$(pwd)"
LOG="$QW/verify.log"
: > "$LOG"

step() { echo; echo "==== $1 ====" | tee -a "$LOG"; }

pass() { printf 'PASS  %s\n' "$1" | tee -a "$LOG"; }
fail() { printf 'FAIL  %s\n' "$1" | tee -a "$LOG"; }

# Tools
step "toolchain probe"
node --version >>"$LOG" 2>&1 && pass "node $(node --version)" || fail "node"
if command -v forge >/dev/null 2>&1; then forge --version >>"$LOG" 2>&1 && pass "forge" || fail "forge"; else fail "forge (not on PATH)"; fi
if command -v anvil >/dev/null 2>&1; then pass "anvil"; else fail "anvil (not on PATH - e2e will self-skip)"; fi

# 1. node_modules junction (target = monorepo apps/web/node_modules)
step "junction node_modules -> apps/web/node_modules"
if [ -d node_modules ]; then
  pass "node_modules already present"
else
  node -e "require('fs').symlinkSync('c:/Users/tdat/Desktop/0xnothing/0xNothing-zkLTC-Testnet/apps/web/node_modules','node_modules','junction')" >>"$LOG" 2>&1 \
    && pass "junction created" || fail "junction (not required - nodehooks.mjs covers node runs)"
fi

# 2. SDK tests
step "SDK tests (wots/digest/icons)"
( cd sdk && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ../nodehooks.mjs --test --experimental-strip-types test/*.test.ts ) >>"$LOG" 2>&1 \
  && pass "sdk tests" || fail "sdk tests (tail below)"

# 3. Generate cross-language vectors
step "generate vectors (contracts/test/vectors/HashSigVectors.data.sol)"
( cd sdk && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ../nodehooks.mjs --experimental-strip-types test/vectors.gen.ts ) >>"$LOG" 2>&1 \
  && pass "vectors generated" || fail "vectors generation"

# 4. Contracts: build
step "forge build (contracts/)"
( cd contracts && forge build ) >>"$LOG" 2>&1 && pass "forge build" || fail "forge build"

# 5. Contracts: test (incl. HashSigVectors replay + 2 regression tests)
step "forge test (contracts/)"
( cd contracts && forge test -vv ) >>"$LOG" 2>&1 && pass "forge test" || fail "forge test (see tail)"

# 6. Relayer: policy unit tests
step "relayer policy tests"
( cd relayer && npm test ) >>"$LOG" 2>&1 && pass "relayer policy tests" || fail "relayer policy tests"

# 7. Relayer: anvil e2e (self-skips if anvil missing; needs forge artifacts from #4)
step "relayer anvil e2e"
( cd relayer && node --import ../nodehooks.mjs --experimental-strip-types test/e2e.ts ) >>"$LOG" 2>&1 \
  && pass "anvil e2e" || fail "anvil e2e (see tail)"

echo | tee -a "$LOG"
echo "==== SUMMARY ====" | tee -a "$LOG"
echo "Full log: $LOG" | tee -a "$LOG"
tail -n 60 "$LOG"
