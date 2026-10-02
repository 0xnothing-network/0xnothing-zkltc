# 0xPixel V2 third-party notices

`src/0xpixel/PixelERC721.sol` is adapted from the vendored OpenZeppelin Contracts
5.6.1 ERC721 implementation. Its default URI implementation is removed to keep
the existing Paris EVM target; V2 supplies its own immutable metadata. The
vendored OpenZeppelin interfaces, ERC165/receiver utilities and test Base64
retain their original notices in `../0xFi/contracts/lib/openzeppelin-contracts`.

`src/0xpixel/PixelBase64.sol` contains code adapted from Solady Base64 by
Vectorized, with original attribution in its source header:
https://github.com/Vectorized/solady/blob/main/src/utils/Base64.sol

The MIT License (MIT)

Copyright (c) 2016-2026 Zeppelin Group Ltd

Copyright (c) 2022-2026 Solady

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
