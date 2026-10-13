import { parseAbi } from "viem";

export const faucetAbi = parseAbi([
  "function nusd() view returns (address)",
  "function nativeDrip() view returns (uint256)",
  "function nusdDrip() view returns (uint256)",
  "function cooldownSeconds() view returns (uint256)",
  "function dailyNativeCap() view returns (uint256)",
  "function dailyNusdCap() view returns (uint256)",
  "function currentUtcDay() view returns (uint64)",
  "function dailyNativeDispensed() view returns (uint256)",
  "function dailyNusdDispensed() view returns (uint256)",
  "function paused() view returns (bool)",
  "function lastClaimAt(address account) view returns (uint256)",
  "function dailyRemaining() view returns (uint256 nativeRemaining, uint256 nusdRemaining)",
  "function previewClaim(address account) view returns (bool allowed, uint256 readyAt, uint256 nativeAmount, uint256 nusdAmount)",
  "function claim()",
]);
