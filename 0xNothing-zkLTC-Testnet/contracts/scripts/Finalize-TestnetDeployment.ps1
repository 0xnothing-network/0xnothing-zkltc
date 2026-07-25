param(
    [string]$BroadcastPath = "",
    [string]$RpcUrl = $env:LITVM_RPC_URL,
    [string]$SubgraphUrl = "",
    [string]$SubgraphVersion = "0.1.3",
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$contractsRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseRoot = (Resolve-Path (Join-Path $contractsRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($BroadcastPath)) {
    $BroadcastPath = Join-Path $contractsRoot "broadcast\DeployTestnet.s.sol\4441\run-latest.json"
}
$BroadcastPath = (Resolve-Path -LiteralPath $BroadcastPath).Path

function Convert-ReceiptBlock {
    param([object]$Value)

    $text = [string]$Value
    if ($text.StartsWith("0x", [System.StringComparison]::OrdinalIgnoreCase)) {
        return [Convert]::ToInt64($text.Substring(2), 16)
    }
    return [Int64]::Parse($text, [System.Globalization.CultureInfo]::InvariantCulture)
}

function Set-JsonProperty {
    param([object]$Target, [string]$Name, [object]$Value)

    if ($null -ne $Target.PSObject.Properties[$Name]) {
        $Target.$Name = $Value
    } else {
        $Target | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Get-JsonPropertyValue {
    param([object]$Target, [string]$Name)

    $property = $Target.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Set-EnvValue {
    param([string]$Content, [string]$Name, [string]$Value)

    $pattern = "(?m)^$([Regex]::Escape($Name))=.*$"
    $line = "$Name=$Value"
    if ([Regex]::IsMatch($Content, $pattern)) {
        return [Regex]::Replace($Content, $pattern, $line)
    }
    return $Content.TrimEnd() + [Environment]::NewLine + $line + [Environment]::NewLine
}

function Remove-EnvValue {
    param([string]$Content, [string]$Name)

    $pattern = "(?m)^$([Regex]::Escape($Name))=.*(?:\r?\n|$)"
    return [Regex]::Replace($Content, $pattern, "")
}

function Test-UsableAddress {
    param([object]$Value)

    $text = [string]$Value
    return $text -match "^0x[0-9a-fA-F]{40}$" -and
        $text -ne "0x0000000000000000000000000000000000000000"
}

function Invoke-Cast {
    param([string[]]$Arguments)

    $output = & cast @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "cast failed: $($output -join [Environment]::NewLine)"
    }
    return ($output -join [Environment]::NewLine).Trim()
}

function Assert-LiveAddressCall {
    param(
        [string]$ContractAddress,
        [string]$Signature,
        [string]$ExpectedAddress,
        [string]$Label
    )

    $output = Invoke-Cast -Arguments @("call", $ContractAddress, $Signature, "--rpc-url", $RpcUrl)
    $match = [Regex]::Match($output, "0x[0-9a-fA-F]{40}")
    if (-not $match.Success) {
        throw "Could not decode live address for ${Label}: $output"
    }
    if (-not $match.Value.Equals($ExpectedAddress, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Live $Label mismatch. Expected $ExpectedAddress, received $($match.Value)."
    }
}

function Get-LiveUintCall {
    param(
        [string]$ContractAddress,
        [string]$Signature,
        [string]$Label
    )

    $output = Invoke-Cast -Arguments @("call", $ContractAddress, $Signature, "--rpc-url", $RpcUrl)
    $match = [Regex]::Match($output, "^\s*([0-9]+)")
    if (-not $match.Success) {
        throw "Could not decode live uint256 for ${Label}: $output"
    }

    try {
        return [System.Numerics.BigInteger]::Parse(
            $match.Groups[1].Value,
            [System.Globalization.CultureInfo]::InvariantCulture
        ).ToString([System.Globalization.CultureInfo]::InvariantCulture)
    } catch {
        throw "Could not parse live uint256 for ${Label}: $output"
    }
}

function Assert-LiveUintCall {
    param(
        [string]$ContractAddress,
        [string]$Signature,
        [string]$ExpectedValue,
        [string]$Label
    )

    $actualValue = Get-LiveUintCall $ContractAddress $Signature $Label
    if ($actualValue -ne $ExpectedValue) {
        throw "Live $Label mismatch. Expected $ExpectedValue, received $actualValue."
    }
    return $actualValue
}

function Assert-LiveBoolCall {
    param(
        [string]$ContractAddress,
        [string]$Signature,
        [bool]$ExpectedValue,
        [string]$Label,
        [string[]]$CallArguments = @()
    )

    $arguments = @("call", $ContractAddress, $Signature) + $CallArguments + @("--rpc-url", $RpcUrl)
    $output = Invoke-Cast -Arguments $arguments
    $normalized = $output.Trim().ToLowerInvariant()
    if ($normalized -notin @("true", "false")) {
        throw "Could not decode live bool for ${Label}: $output"
    }
    $actualValue = $normalized -eq "true"
    if ($actualValue -ne $ExpectedValue) {
        throw "Live $Label mismatch. Expected $ExpectedValue, received $actualValue."
    }
    return $actualValue
}

$broadcast = Get-Content -LiteralPath $BroadcastPath -Raw | ConvertFrom-Json
$expectedChainId = [Int64]4441
$broadcastChainValue = if ($null -ne $broadcast.PSObject.Properties["chain"]) {
    $broadcast.chain
} elseif ($null -ne $broadcast.PSObject.Properties["chainId"]) {
    $broadcast.chainId
} else {
    throw "Broadcast file does not contain a chain or chainId field."
}
$broadcastChainId = Convert-ReceiptBlock $broadcastChainValue
if ($broadcastChainId -ne $expectedChainId) {
    throw "Broadcast chain mismatch. Expected $expectedChainId, received $broadcastChainId."
}
if ([string]::IsNullOrWhiteSpace($RpcUrl)) {
    throw "LITVM_RPC_URL or -RpcUrl is required for live post-deployment verification."
}

$receiptByHash = @{}
foreach ($receipt in @($broadcast.receipts)) {
    $receiptHash = [string]$receipt.transactionHash
    if (-not [string]::IsNullOrWhiteSpace($receiptHash)) {
        $receiptByHash[$receiptHash.ToLowerInvariant()] = $receipt
    }
}

$requiredContracts = @(
    "DIAOracleAdapter",
    "OracleNUSD",
    "PermanentLiquidityLocker",
    "GraduationRouter",
    "ZeroXPump"
)
$records = [ordered]@{}

foreach ($contractName in $requiredContracts) {
    $matches = @($broadcast.transactions | Where-Object {
        $_.transactionType -eq "CREATE" -and $_.contractName -eq $contractName
    })
    if ($matches.Count -ne 1) {
        throw "Expected exactly one CREATE transaction for $contractName; found $($matches.Count)."
    }

    $transaction = $matches[0]
    $transactionHash = [string]$transaction.hash
    if ([string]::IsNullOrWhiteSpace($transactionHash) -and
        $null -ne $transaction.PSObject.Properties["transactionHash"]) {
        $transactionHash = [string]$transaction.transactionHash
    }
    if ([string]::IsNullOrWhiteSpace($transactionHash)) {
        throw "Missing transaction hash for $contractName."
    }

    $hashKey = $transactionHash.ToLowerInvariant()
    if (-not $receiptByHash.ContainsKey($hashKey)) {
        throw "Missing receipt for $contractName transaction $transactionHash."
    }
    $receipt = $receiptByHash[$hashKey]
    if ([string]$receipt.status -notin @("0x1", "1")) {
        throw "Deployment transaction for $contractName did not succeed."
    }

    $address = [string]$transaction.contractAddress
    if ([string]::IsNullOrWhiteSpace($address)) {
        $address = [string]$receipt.contractAddress
    }
    if ($address -notmatch "^0x[0-9a-fA-F]{40}$") {
        throw "Invalid deployed address for ${contractName}: $address"
    }

    $records[$contractName] = [ordered]@{
        address = $address
        transactionHash = $transactionHash
        receiptBlock = Convert-ReceiptBlock $receipt.blockNumber
    }
}

$oracleNusdTransactions = @($broadcast.transactions | Where-Object {
    $_.transactionType -eq "CREATE" -and $_.contractName -eq "OracleNUSD"
})
$oracleNusdConstructorArguments = @($oracleNusdTransactions[0].arguments)
if ($oracleNusdConstructorArguments.Count -ne 3) {
    throw "Expected three OracleNUSD constructor arguments; found $($oracleNusdConstructorArguments.Count)."
}
$constructorOracleAddress = [string]$oracleNusdConstructorArguments[0]
$protocolAdmin = [string]$oracleNusdConstructorArguments[1]
$constructorSupplyCeiling = [string]$oracleNusdConstructorArguments[2]
if (-not $constructorOracleAddress.Equals(
    $records["DIAOracleAdapter"].address,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw "OracleNUSD constructor oracle does not match the deployed DIAOracleAdapter."
}
if (-not (Test-UsableAddress $protocolAdmin)) {
    throw "Invalid OracleNUSD protocol admin constructor argument: $protocolAdmin"
}
try {
    $expectedSupplyCeilingNusd = [System.Numerics.BigInteger]::Parse(
        $constructorSupplyCeiling,
        [System.Globalization.CultureInfo]::InvariantCulture
    )
} catch {
    throw "Invalid OracleNUSD supply ceiling constructor argument: $constructorSupplyCeiling"
}
if ($expectedSupplyCeilingNusd -le [System.Numerics.BigInteger]::Zero) {
    throw "OracleNUSD supply ceiling must be greater than zero."
}
$expectedSupplyCeilingNusd = $expectedSupplyCeilingNusd.ToString(
    [System.Globalization.CultureInfo]::InvariantCulture
)

$liveChainId = Convert-ReceiptBlock (Invoke-Cast -Arguments @("chain-id", "--rpc-url", $RpcUrl))
if ($liveChainId -ne $expectedChainId) {
    throw "RPC chain mismatch. Expected $expectedChainId, received $liveChainId."
}

foreach ($contractName in $requiredContracts) {
    $code = Invoke-Cast -Arguments @("code", $records[$contractName].address, "--rpc-url", $RpcUrl)
    if ($code -notmatch "^0x[0-9a-fA-F]+$" -or $code -eq "0x") {
        throw "No live bytecode found for $contractName at $($records[$contractName].address)."
    }
}

Assert-LiveAddressCall $records["OracleNUSD"].address "oracle()(address)" `
    $records["DIAOracleAdapter"].address "OracleNUSD.oracle"
Assert-LiveAddressCall $records["OracleNUSD"].address "vault()(address)" `
    $records["OracleNUSD"].address "OracleNUSD.vault"
Assert-LiveAddressCall $records["ZeroXPump"].address "NUSD()(address)" `
    $records["OracleNUSD"].address "Pump.NUSD"
Assert-LiveAddressCall $records["ZeroXPump"].address "vault()(address)" `
    $records["OracleNUSD"].address "Pump.vault"
Assert-LiveAddressCall $records["ZeroXPump"].address "graduationRouter()(address)" $records["GraduationRouter"].address "Pump.graduationRouter"
Assert-LiveAddressCall $records["GraduationRouter"].address "pump()(address)" $records["ZeroXPump"].address "Router.pump"
Assert-LiveAddressCall $records["PermanentLiquidityLocker"].address "router()(address)" $records["GraduationRouter"].address "Locker.router"

$tokenImplementationOutput = Invoke-Cast -Arguments @(
    "call",
    $records["ZeroXPump"].address,
    "tokenImplementation()(address)",
    "--rpc-url",
    $RpcUrl
)
$tokenImplementationMatch = [Regex]::Match($tokenImplementationOutput, "0x[0-9a-fA-F]{40}")
if (-not $tokenImplementationMatch.Success) {
    throw "Could not decode Pump.tokenImplementation: $tokenImplementationOutput"
}
$pumpTokenImplementation = $tokenImplementationMatch.Value
$tokenImplementationCode = Invoke-Cast -Arguments @("code", $pumpTokenImplementation, "--rpc-url", $RpcUrl)
if ($tokenImplementationCode -notmatch "^0x[0-9a-fA-F]+$" -or $tokenImplementationCode -eq "0x") {
    throw "No live PumpToken implementation bytecode found at $pumpTokenImplementation."
}

$supplyCeilingNusd = Assert-LiveUintCall $records["OracleNUSD"].address `
    "supplyCeilingNusd()(uint256)" $expectedSupplyCeilingNusd "OracleNUSD.supplyCeilingNusd"
$mintPaused = Assert-LiveBoolCall $records["OracleNUSD"].address `
    "mintPaused()(bool)" $false "OracleNUSD.mintPaused"
$redeemPaused = Assert-LiveBoolCall $records["OracleNUSD"].address `
    "redeemPaused()(bool)" $false "OracleNUSD.redeemPaused"
$pumpPaused = Assert-LiveBoolCall $records["ZeroXPump"].address `
    "paused()(bool)" $false "Pump.paused"

$defaultAdminRole = "0x" + ("0" * 64)
$pauserRoleOutput = Invoke-Cast -Arguments @(
    "call",
    $records["OracleNUSD"].address,
    "PAUSER_ROLE()(bytes32)",
    "--rpc-url",
    $RpcUrl
)
$pauserRoleMatch = [Regex]::Match($pauserRoleOutput, "0x[0-9a-fA-F]{64}")
if (-not $pauserRoleMatch.Success) {
    throw "Could not decode OracleNUSD.PAUSER_ROLE: $pauserRoleOutput"
}
Assert-LiveBoolCall $records["OracleNUSD"].address "hasRole(bytes32,address)(bool)" $true `
    "OracleNUSD DEFAULT_ADMIN_ROLE binding" @($defaultAdminRole, $protocolAdmin)
Assert-LiveBoolCall $records["OracleNUSD"].address "hasRole(bytes32,address)(bool)" $true `
    "OracleNUSD PAUSER_ROLE binding" @($pauserRoleMatch.Value, $protocolAdmin)

$expectedInitialVirtualNusdReserve = "1500000000000000000000"
$expectedGraduationMarketCapTargetNusd = "6000000000000000000000"
$expectedGraduationReserveThresholdNusd = "1500000000000000000000"
$expectedCreateFeeNusd = "1000000000000000000"
$expectedTradeFeeBps = "10"

$initialVirtualNusdReserve = Assert-LiveUintCall $records["ZeroXPump"].address `
    "initialVirtualNusdReserve()(uint256)" $expectedInitialVirtualNusdReserve "Pump.initialVirtualNusdReserve"
$graduationMarketCapTargetNusd = Assert-LiveUintCall $records["ZeroXPump"].address `
    "graduationThresholdNusd()(uint256)" $expectedGraduationMarketCapTargetNusd "Pump.graduationThresholdNusd"
$graduationReserveThresholdNusd = Assert-LiveUintCall $records["ZeroXPump"].address `
    "graduationReserveThresholdNusd()(uint256)" $expectedGraduationReserveThresholdNusd `
    "Pump.graduationReserveThresholdNusd"
$createFeeNusd = Assert-LiveUintCall $records["ZeroXPump"].address `
    "createFee()(uint256)" $expectedCreateFeeNusd "Pump.createFee"
$tradeFeeBps = Assert-LiveUintCall $records["ZeroXPump"].address `
    "tradeFeeBps()(uint256)" $expectedTradeFeeBps "Pump.tradeFeeBps"
$routerEnabled = Assert-LiveBoolCall $records["GraduationRouter"].address `
    "enabled()(bool)" $false "Router.enabled"
$routerEnableAt = Assert-LiveUintCall $records["GraduationRouter"].address `
    "enableAt()(uint256)" "0" "Router.enableAt"

$verifiedConfiguration = [ordered]@{
    unit = "wei"
    initialVirtualNusdReserve = $initialVirtualNusdReserve
    graduationMarketCapTargetNusd = $graduationMarketCapTargetNusd
    graduationReserveThresholdNusd = $graduationReserveThresholdNusd
    createFeeNusd = $createFeeNusd
    tradeFeeBps = [int]$tradeFeeBps
}
$verifiedRiskModel = [ordered]@{
    version = "oracle-nusd-v1"
    model = "oracle-priced-native-reserve"
    collateralAsset = "native-zkLTC"
    supplyCeilingNusd = $supplyCeilingNusd
    supplyCeilingUnit = "NUSD wei"
    mintFeeBps = 0
    redeemFeeBps = 0
    mintPaused = $mintPaused
    redeemPaused = $redeemPaused
    pumpPaused = $pumpPaused
    vaultCompatibility = "self"
    legacyPositionsMigrated = $false
}
$verifiedGraduationState = [ordered]@{
    enabled = $routerEnabled
    enableAt = $routerEnableAt
}
$pendingSourceVerification = [ordered]@{
    status = "pending"
    explorer = "https://liteforge.explorer.caldera.xyz"
    compiler = "v0.8.34+commit.80d5c536"
    optimizerRuns = 20000
    evmVersion = "paris"
    verifiedContractCount = 0
}

$pumpStartBlock = [Int64]$records["ZeroXPump"].receiptBlock
$summary = [ordered]@{
    chainId = $expectedChainId
    liveVerified = $true
    broadcastFile = $BroadcastPath
    pumpStartBlock = $pumpStartBlock
    contracts = $records
    pumpTokenImplementation = $pumpTokenImplementation
    configuration = $verifiedConfiguration
    riskModel = $verifiedRiskModel
    graduation = $verifiedGraduationState
}

Write-Output ($summary | ConvertTo-Json -Depth 10)
if (-not $Apply) {
    Write-Host "Dry run only. Re-run with -Apply after reviewing receipt addresses and blocks."
    exit 0
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$deploymentPath = Join-Path $releaseRoot "deployments\liteforge-testnet\deployments.json"
$deployment = Get-Content -LiteralPath $deploymentPath -Raw | ConvertFrom-Json
$pumpDeployment = $deployment.pump
$previousNusd = Get-JsonPropertyValue $pumpDeployment "nusd"
$previousVault = Get-JsonPropertyValue $pumpDeployment "nativeCollateralVault"
$legacyNusd = Get-JsonPropertyValue $pumpDeployment "legacyNusd"
$legacyNativeCollateralVault = Get-JsonPropertyValue $pumpDeployment "legacyNativeCollateralVault"
if (-not (Test-UsableAddress $legacyNusd) -and
    (Test-UsableAddress $previousNusd) -and
    -not ([string]$previousNusd).Equals(
        $records["OracleNUSD"].address,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    $legacyNusd = [string]$previousNusd
}
if (-not (Test-UsableAddress $legacyNativeCollateralVault) -and
    (Test-UsableAddress $previousVault) -and
    -not ([string]$previousVault).Equals(
        $records["OracleNUSD"].address,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    $legacyNativeCollateralVault = [string]$previousVault
}

Set-JsonProperty $pumpDeployment "broadcasted" $true
Set-JsonProperty $pumpDeployment "liveVerified" $true
Set-JsonProperty $pumpDeployment "oracleNusd" $records["OracleNUSD"].address
Set-JsonProperty $pumpDeployment "nusd" $records["OracleNUSD"].address
Set-JsonProperty $pumpDeployment "nusdVault" $records["OracleNUSD"].address
Set-JsonProperty $pumpDeployment "diaOracleAdapter" $records["DIAOracleAdapter"].address
Set-JsonProperty $pumpDeployment "nativeCollateralVault" $null
if (Test-UsableAddress $legacyNusd) {
    Set-JsonProperty $pumpDeployment "legacyNusd" $legacyNusd
}
if (Test-UsableAddress $legacyNativeCollateralVault) {
    Set-JsonProperty $pumpDeployment "legacyNativeCollateralVault" $legacyNativeCollateralVault
}
Set-JsonProperty $pumpDeployment "permanentLiquidityLocker" $records["PermanentLiquidityLocker"].address
Set-JsonProperty $pumpDeployment "graduationRouter" $records["GraduationRouter"].address
Set-JsonProperty $pumpDeployment "launchpad" $records["ZeroXPump"].address
Set-JsonProperty $pumpDeployment "pumpTokenImplementation" $pumpTokenImplementation
Set-JsonProperty $pumpDeployment "deploymentBlock" $pumpStartBlock
Set-JsonProperty $pumpDeployment "transactions" $records
Set-JsonProperty $pumpDeployment "configuration" $verifiedConfiguration
Set-JsonProperty $pumpDeployment "riskModel" $verifiedRiskModel
Set-JsonProperty $pumpDeployment "graduation" $verifiedGraduationState
Set-JsonProperty $pumpDeployment "sourceVerification" $pendingSourceVerification
if (-not [string]::IsNullOrWhiteSpace($SubgraphUrl)) {
    Set-JsonProperty $pumpDeployment "subgraphUrl" $SubgraphUrl.Trim()
}
if (-not [string]::IsNullOrWhiteSpace($SubgraphVersion)) {
    Set-JsonProperty $pumpDeployment "subgraphVersion" $SubgraphVersion.Trim()
}
[IO.File]::WriteAllText(
    $deploymentPath,
    ($deployment | ConvertTo-Json -Depth 12) + [Environment]::NewLine,
    $utf8NoBom
)

$subgraphConfigPath = Join-Path $releaseRoot "subgraphs\0xpump\subgraph.config.json"
$subgraphConfig = Get-Content -LiteralPath $subgraphConfigPath -Raw | ConvertFrom-Json
$subgraphConfig.contractAddress = $records["ZeroXPump"].address
$subgraphConfig.startBlock = $pumpStartBlock
$subgraphConfig.deploymentVersion = $SubgraphVersion.Trim()
[IO.File]::WriteAllText(
    $subgraphConfigPath,
    ($subgraphConfig | ConvertTo-Json -Depth 8) + [Environment]::NewLine,
    $utf8NoBom
)

$envExamplePath = Join-Path $releaseRoot "apps\web\.env.example"
$envLocalPath = Join-Path $releaseRoot "apps\web\.env.local"
$envContent = if (Test-Path -LiteralPath $envLocalPath) {
    [IO.File]::ReadAllText($envLocalPath)
} else {
    [IO.File]::ReadAllText($envExamplePath)
}
foreach ($removedName in @(
    "NEXT_PUBLIC_NUSD_VAULT_ADDRESS",
    "NEXT_PUBLIC_LEGACY_NUSD_ADDRESS",
    "NEXT_PUBLIC_LEGACY_NUSD_VAULT_ADDRESS"
)) {
    $envContent = Remove-EnvValue $envContent $removedName
}
$envContent = Set-EnvValue $envContent "NEXT_PUBLIC_PUMP_FACTORY_ADDRESS" $records["ZeroXPump"].address
$envContent = Set-EnvValue $envContent "NEXT_PUBLIC_NUSD_ADDRESS" $records["OracleNUSD"].address
$envContent = Set-EnvValue $envContent "NEXT_PUBLIC_PUMP_START_BLOCK" ([string]$pumpStartBlock)
if (-not [string]::IsNullOrWhiteSpace($SubgraphUrl)) {
    $envContent = Set-EnvValue $envContent "NEXT_PUBLIC_PUMP_SUBGRAPH_URL" $SubgraphUrl.Trim()
}
[IO.File]::WriteAllText($envLocalPath, $envContent, $utf8NoBom)

$subgraphRoot = Join-Path $releaseRoot "subgraphs\0xpump"
Push-Location $subgraphRoot
try {
    & npm.cmd run configure
    if ($LASTEXITCODE -ne 0) {
        throw "0xPump subgraph configuration failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

Write-Host "Updated deployment manifest: $deploymentPath"
Write-Host "Updated subgraph config from actual ZeroXPump receipt block: $pumpStartBlock"
Write-Host "Updated web public runtime file: $envLocalPath"
