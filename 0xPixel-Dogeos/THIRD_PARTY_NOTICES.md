# Third-party notices

`contracts/src/PixelERC721.sol` is the local 0xPixel adaptation of OpenZeppelin ERC-721 (MIT). Its upstream attribution and SPDX notices are retained. `PixelBase64.sol` also retains its upstream MIT attribution. OpenZeppelin Contracts 5.6.0 is installed as a dependency and provides interfaces, ERC721 receiver handling and ReentrancyGuard.

`DogeosPixel.sol` copies the existing repository's ZeroXPixelV2 implementation, retaining on-chain packed run encoding, bytecode data storage, immutable metadata, UTF-8 checks, original-art hashing and renderer. Collections and ownership nonces are additions for this standalone app.

Frontend dependencies include React, viem, Phosphor Icons, Express, Vite and Space Grotesk. Their license files remain in their package distributions. Space Grotesk is self-hosted from its font package.

Graph toolchain overrides use `@xhmikosr/decompress` as a maintained compatible archive-extraction replacement, together with patched dependency versions. These packages are build/deploy tooling and are not shipped in the browser bundle.
