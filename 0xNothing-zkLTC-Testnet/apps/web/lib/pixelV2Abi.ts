import { parseAbi } from "viem";

export const PixelV2ABI = parseAbi([
  "function mintPacked(string artName,string description,uint256 grid,bytes pixels) returns (uint256)",
  "function checkOriginalPacked(bytes pixels,uint256 grid) view returns (bool)",
  "function getCreatorPacked(bytes pixels,uint256 grid) view returns (address)",
  "function tokenPackedData(uint256 tokenId) view returns (string artName,string description,uint256 grid,bytes pixels,address creator,uint256 mintedAt,bytes32 artworkHash)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function VERSION() view returns (uint256)",
  "event Minted(address indexed creator,uint256 indexed tokenId,string name)",
]);
