# 0xPixel V2

V2 is a separate immutable collection with free minting, fully on-chain SVG
artwork and ERC-721 JSON metadata. It retains creator royalties of 1% through
ERC-2981. The existing collection and marketplace continue to function.

## Canvas and compression

Supported square grids are 8, 16, 32, 64, 128 and 256. Grid size is stored as
`uint16`, so 256 cannot truncate to zero. Each horizontal RGB run occupies six
binary bytes: `[x, y, countMinusOne, red, green, blue]`. The width is
`countMinusOne + 1`, including a full 256-pixel row. Unpainted cells are
transparent.

Minting accepts at most 4,096 runs / 24,576 packed bytes. A 256 grid therefore
does not admit every possible high-detail image: a checkerboard with 65,536
single-pixel runs exceeds the limit. The editor counts compressed runs and
rejects excess complexity before requesting a wallet signature.

Runs must be row-major, non-overlapping, within bounds and maximal: two
touching runs of the same color must be combined. This produces one canonical
encoding for each admitted artwork. Originality is enforced within V2 using
the grid plus canonical bytes; the legacy collection has its own registry.

Pixel bytes are stored in immutable STOP-prefixed contracts. The first payload
chunk is at most 24,570 bytes and the second is at most six bytes. Their runtime
code is below the [EIP-170](https://eips.ethereum.org/EIPS/eip-170) 24,576-byte
limit. This avoids the legacy hex string's many storage slots.

## Mint and metadata API

```solidity
mintPacked(string artName, string description, uint256 grid, bytes pixels)
tokenPackedData(uint256 tokenId)
tokenData(uint256 tokenId)
tokenURI(uint256 tokenId)
checkOriginalPacked(bytes pixels, uint256 grid)
getCreatorPacked(bytes pixels, uint256 grid)
```

Names are nonempty and at most 64 UTF-8 bytes; descriptions are at most 1,024
UTF-8 bytes. Invalid UTF-8 is rejected. JSON quotes, backslashes and control
characters are escaped. Minted names/descriptions/artwork/creator/timestamps
are immutable even after ownership changes.

`tokenURI` returns base64 JSON with `name`, the actual user `description`, an
embedded SVG `image`, `artwork_hash` and attributes for Grid Size, Creator,
Minted At, Run Count and Encoding Version. It implements the
[ERC-721 metadata extension](https://eips.ethereum.org/EIPS/eip-721) and
[ERC-2981](https://eips.ethereum.org/EIPS/eip-2981).

`tokenData` preserves the legacy six-field tuple. Its hex runs use the old
positive count format; a 256-wide run is represented as 255+1. Existing readers
can render V2 without interpreting the new mint codec. `tokenPackedData`
returns the new binary representation and description explicitly.

`Minted` and `ArtworkRegistered` event signatures are retained. Standard safe
ERC-721 mint/transfer receiver checks and owner token enumeration are tested,
including a receiver that forwards the NFT during mint.

## Deployment and compatibility

The verified public deployment record is
`../deployments/liteforge-testnet/pixel-v2.json`. It contains the transaction,
address, start block, runtime hash, receipt costs and a live 256-grid smoke NFT.
V2 is `0xd83cb7acef921f98b6b983cbb712a583869da9eb` on chain 4441, deployed at
block 56,305,414. Its complete runtime matches the locally tested artifact.
The explorer currently indexes about 83% of blocks and rejects verification
because it does not recognize the new contract address. The standard compiler
input is saved in `output/pixel-v2-2026-10-01/standard-input.json`; explorer
source verification remains pending.
The combined deployment manifest preserves `pixel.legacyNft` and its start
block while `pixel.nft` selects V2. The marketplace accepts either collection.

Build/test with the repository's vendored dependencies:

```powershell
forge test --root 0xNothing-zkLTC-Testnet/contracts --match-contract ZeroXPixelV2Test -vv
node 0xNothing-zkLTC-Testnet/contracts/scripts/deploy-pixel-v2.mjs
node 0xNothing-zkLTC-Testnet/contracts/scripts/deploy-pixel-v2.mjs --broadcast --smoke-mint
```

The first Node command only estimates. The broadcast command reads the key
from the testnet root `.env.local` in process memory; it never accepts a key as
a command argument or logs credential-bearing errors. It requires chain 4441,
caps each transaction's maximum cost at 0.05 testnet zkLTC, simulates before
signing, journals submitted transactions for retry and verifies the complete
deployed runtime against the current compiled artifact before promotion.

Web/ví identities and caches use collection + token ID. Historical image URLs
without a collection continue to resolve the legacy collection. Both NFT
generations remain readable and transferable. The new subgraph datasource is
included in the local build; until it is published, the web uses RPC/explorer
fallbacks for V2 rather than relying on the legacy hosted index.
Activity uses bounded, unbatched RPC log reads for recent events while merging
available explorer history; provider timeouts and range limits split ranges.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for OpenZeppelin and Solady
attribution and license notices.
