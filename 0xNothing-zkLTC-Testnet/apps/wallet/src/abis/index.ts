import { parseAbi } from "viem";

/**
 * Every ABI fragment the wallet needs, in one place.
 *
 * Signatures are copied from apps/web/features/fi/lib/abis/* and
 * apps/web/lib/abi.ts — the wallet must speak to the deployed contracts with
 * exactly the same selectors the web app already proves to work on chain.
 * Human-readable form keeps the list auditable at a glance.
 */

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Optional metadata exposed by 0xPump-launched ERC-20s. */
export const tokenImageAbi = parseAbi([
  "function imageURI() view returns (string)",
]);

/** NUSD is both the ERC-20 and the oracle mint/redeem module. */
export const nusdOracleAbi = parseAbi([
  "function oracle() view returns (address)",
  "function quoteMint(uint256 collateralWei) view returns (uint256 amountNusd)",
  "function mintAtOracle(uint256 minNusdOut, address recipient) payable returns (uint256 amountNusd)",
  "function quoteRedeem(uint256 amountNusd) view returns (uint256 collateralOutWei)",
  "function redeemAtOracle(uint256 amountNusd, uint256 minCollateralOutWei, address recipient) returns (uint256 collateralOutWei)",
  "function mintPaused() view returns (bool)",
  "function redeemPaused() view returns (bool)",
  "function supplyCeilingNusd() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function totalCollateralWei() view returns (uint256)",
]);

export const dexFactoryAbi = parseAbi([
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256 index) view returns (address pair)",
  "function swapsPaused() view returns (bool)",
]);

export const dexPoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
]);

export const dexRouterAbi = parseAbi([
  "function LP_FEE_BPS() view returns (uint256)",
  "function PROTOCOL_FEE_BPS() view returns (uint256)",
  "function ROUTE_SURCHARGE_BPS() view returns (uint256)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactNativeForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForNative(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);

/** 0xPump bonding-curve market. TRADING/READY markets use this before AMM graduation. */
export const zeroXPumpAbi = parseAbi([
  "function buy(address token,uint256 maxNusdIn,uint256 minTokenOut,uint256 deadline) returns (uint256 tokenOut,uint256 userNusdAmount)",
  "function sell(address token,uint256 tokenIn,uint256 minNusdOut,uint256 deadline) returns (uint256 userNusdAmount)",
  "function quoteBuy(address token,uint256 maxNusdIn) view returns (uint256 tokenOut,uint256 curveNusdAmount,uint256 userNusdAmount,uint256 feeNusd,bool readyAfter)",
  "function quoteSell(address token,uint256 tokenIn) view returns (uint256 curveNusdAmount,uint256 userNusdAmount,uint256 feeNusd)",
  "function status(address token) view returns (uint8)",
  "function spotPriceNusdWad(address token) view returns (uint256)",
  "function getAllTokens() view returns (address[] tokens)",
  "function paused() view returns (bool)",
]);

/** 0xFi lending pool; distinct from fixed-duration points staking. */
export const lendingPoolAbi = parseAbi([
  "function supply(uint256 amount, address onBehalfOf) returns (uint256 shares)",
  "function withdraw(uint256 amount, address recipient) returns (uint256 assets)",
  "function supplyBalance(address account) view returns (uint256)",
  "function maxWithdraw(address account) view returns (uint256)",
  "function supplyRate() view returns (uint256 rateWad)",
  "function lenderRate() pure returns (uint256 rateWad)",
  "function availableLiquidity() view returns (uint256)",
  "function totalSupplied() view returns (uint256)",
  "function totalBorrowed() view returns (uint256)",
  "function supplyPaused() view returns (bool)",
  "function activated() view returns (bool)",
]);

/** Public/user surface of the deployed NUSD points staking contract. */
export const nusdPointsStakingAbi = parseAbi([
  "function totalLockedByUser(address account) view returns (uint256)",
  "function earnedPointCredits(address account) view returns (uint256)",
  "function spentPointCredits(address account) view returns (uint256)",
  "function availablePointCredits(address account) view returns (uint256)",
  "function userPositionCount(address account) view returns (uint256)",
  "function userPositionIds(address account, uint256 offset, uint256 limit) view returns (uint256[] ids)",
  "function getPosition(uint256 positionId) view returns ((address account, uint256 amount, uint256 pointCredits, uint64 unlockTime, uint32 lockDuration, bool withdrawn))",
  "function stakingPaused() view returns (bool)",
  "function redemptionsPaused() view returns (bool)",
  "function redemptionEnabled() view returns (bool)",
  "function nusdPerXPointWad() view returns (uint256)",
  "function redemptionReserve() view returns (uint256)",
  "function isSolvent() view returns (bool)",
  "function quoteRedemption(uint256 pointCredits) view returns (uint256)",
  "function stake(uint256 amount, uint32 lockDuration) returns (uint256 positionId)",
  "function withdraw(uint256 positionId)",
  "function redeemPoints(uint256 pointCredits) returns (uint256 nusdOut)",
]);

export const diaOracleAdapterAbi = parseAbi([
  "function isFresh() view returns (bool)",
  "function readPriceWad() view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId)",
]);

export const wzkLtcAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 amount)",
]);

export const pixelNftAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function userTokens(address owner, uint256 index) view returns (uint256)",
  "function tokenData(uint256 tokenId) view returns (string name, uint256 gridSize, string pixelData, address creator, uint256 mintedAt, bytes32 artworkHash)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function transferNFT(address to, uint256 tokenId)",
]);
