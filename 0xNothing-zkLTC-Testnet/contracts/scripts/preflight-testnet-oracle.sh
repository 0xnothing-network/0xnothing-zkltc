#!/usr/bin/env bash
# Live LiteForge DIA preflight. Does not broadcast. Requires `cast` on PATH.
set -euo pipefail

RPC="${LITVM_RPC_URL:?set LITVM_RPC_URL to the LiteForge RPC}"
FEED="${DIA_LTC_USD_FEED:-0x45dDa5d881BD2C917976CCfde74fFd6f6412da29}"
MAX_AGE="${DIA_MAX_PRICE_AGE:-3600}"
MIN_WAD="${DIA_MIN_PRICE_WAD:-1000000000000000000}"
MAX_WAD="${DIA_MAX_PRICE_WAD:-10000000000000000000000}"

chain_id="$(cast chain-id --rpc-url "$RPC")"
if [[ "$chain_id" != "4441" ]]; then
  echo "wrong chain: expected 4441, got $chain_id" >&2
  exit 1
fi

decimals="$(cast call "$FEED" "decimals()(uint8)" --rpc-url "$RPC")"
if [[ "$decimals" != "18" ]]; then
  echo "unexpected feed decimals: $decimals" >&2
  exit 1
fi

raw="$(cast call "$FEED" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$RPC")"
eval "$(python3 - "$raw" "$MAX_AGE" "$MIN_WAD" "$MAX_WAD" <<'PY'
import re, sys, time
raw, max_age, min_wad, max_wad = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
nums = [int(n) for n in re.findall(r"(?<![0-9])(\d+)(?=\s*\[|\s*,|\s*\))", raw)]
if len(nums) < 5:
    sys.stderr.write(f"could not decode latestRoundData: {raw}\n")
    sys.exit(1)
round_id, answer, _started, updated_at, answered_in_round = nums[:5]
age = int(time.time()) - updated_at
if age > max_age:
    sys.stderr.write(f"stale feed: updated {age} seconds ago (max {max_age})\n")
    sys.exit(1)
if age < 0:
    sys.stderr.write(f"future feed timestamp: {updated_at}\n")
    sys.exit(1)
if answer < min_wad or answer > max_wad:
    sys.stderr.write(f"price {answer} outside [{min_wad}, {max_wad}]\n")
    sys.exit(1)
if round_id != answered_in_round:
    sys.stderr.write(f"answeredInRound {answered_in_round} != roundId {round_id}\n")
    sys.exit(1)
print(f"answer={answer}")
print(f"updated_at={updated_at}")
print(f"age={age}")
print(f"round_id={round_id}")
PY
)"

echo "liteforge oracle preflight ok"
echo "  feed=$FEED"
echo "  chainId=$chain_id"
echo "  priceWad=$answer"
echo "  updatedAt=$updated_at ageSec=$age"
echo "  roundId=$round_id"
