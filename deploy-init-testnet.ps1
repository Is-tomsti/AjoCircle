[CmdletBinding()]
param([switch]$Execute)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Rpc = 'https://rpc.testnet.near.org'
$Contract = 'ajocircle.testnet'
$Wasm = Join-Path $ProjectRoot 'contract\target\wasm32-unknown-unknown\release\ajo_circle_contract.wasm'
$ArgsPath = Join-Path $env:TEMP 'ajocircle-init-args.testnet.json'
$ExpectedSha256 = '58AAFA50AD444F3EAE60C5331B89BA2BA067F0E88EB3EAD7718A9550DC8B7DC7'
$Members = @('ajotest1.testnet', 'ajotest2.testnet', 'ajotest3.testnet')
$Contribution = '1000000000000000000000000'
$SignerPublicKey = 'ed25519:Bxzy7CtrtNypFFTic2QUbGRnMjGu3ow7YXB2PG8hdgEA'

function Invoke-Rpc([hashtable]$Body) {
    Invoke-RestMethod -Uri $Rpc -Method Post -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 10 -Compress)
}
function Get-Account([string]$AccountId) {
    $r = Invoke-Rpc @{ jsonrpc='2.0'; id='ajo-preflight'; method='query'; params=@{ request_type='view_account'; finality='final'; account_id=$AccountId } }
    if ($r.error) { throw "Account lookup failed for ${AccountId}: $($r.error | ConvertTo-Json -Compress)" }
    return $r.result
}

# Verify the committed, pushed source/documentation without disturbing unrelated work in the tree.
Push-Location $ProjectRoot
try {
    $dirtyRelevant = git status --porcelain -- contract/src/lib.rs README.md
    if ($LASTEXITCODE -ne 0 -or $dirtyRelevant) { throw 'contract/src/lib.rs or README.md has uncommitted changes.' }
    $head = (git rev-parse HEAD).Trim()
    $remoteLine = (git ls-remote origin refs/heads/main).Trim(); $remote = ($remoteLine -split "\s+")[0]
    if ($LASTEXITCODE -ne 0 -or $head -ne $remote) { throw 'Local HEAD does not match origin/main; push/commit the reviewed changes first.' }
} finally { Pop-Location }

if (-not (Test-Path -LiteralPath $Wasm)) { throw "WASM not found: $Wasm" }
$actualSha = (Get-FileHash -LiteralPath $Wasm -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actualSha -ne $ExpectedSha256) { throw "WASM SHA-256 mismatch. Expected $ExpectedSha256; found $actualSha" }

# Ensure the contract is still uninitialized before building any transaction.
$state = Invoke-Rpc @{ jsonrpc='2.0'; id='ajo-preflight'; method='query'; params=@{ request_type='view_state'; finality='final'; account_id=$Contract; prefix_base64='' } }
if ($state.error) { throw "Contract state query failed: $($state.error | ConvertTo-Json -Compress)" }
if (@($state.result.values).Count -ne 0) { throw 'Contract storage is not empty; refusing to initialize.' }

# Every member must exist and retain 1 NEAR plus a conservative gas allowance.
$minimumMemberBalance = [decimal]1100000000000000000000000
foreach ($member in $Members) {
    $account = Get-Account $member
    if ([decimal]::Parse([string]$account.amount) -lt $minimumMemberBalance) { throw "$member needs at least 1.1 NEAR for contribution plus gas." }
}
$contractAccount = Get-Account $Contract
if ([decimal]::Parse([string]$contractAccount.amount) -lt [decimal]1000000000000000000000000) { throw "$Contract has insufficient balance for deployment gas." }

# Confirm the signer keychain entry is an on-chain full-access key for ajocircle.testnet.
$keyText = cmd.exe /d /c "near account get-public-key from-keychain ajocircle.testnet network-config testnet 2>&1" | Out-String
if ($LASTEXITCODE -ne 0 -or $keyText -notmatch [regex]::Escape($SignerPublicKey)) { throw 'Could not verify the expected ajocircle.testnet keychain public key.' }
$keys = Invoke-Rpc @{ jsonrpc='2.0'; id='ajo-preflight'; method='query'; params=@{ request_type='view_access_key_list'; finality='final'; account_id=$Contract } }
if ($keys.error) { throw "Access-key query failed: $($keys.error | ConvertTo-Json -Compress)" }
$matchingKey = @($keys.result.keys | Where-Object { $_.public_key -eq $SignerPublicKey -and $_.access_key.permission -eq 'FullAccess' })
if ($matchingKey.Count -ne 1) { throw 'The selected keychain public key is not a matching on-chain FullAccess key for ajocircle.testnet.' }

if ($Execute) {
    $confirmation = Read-Host 'Type exactly DEPLOY AND INITIALIZE TESTNET to submit the combined testnet transaction'
    if ($confirmation -cne 'DEPLOY AND INITIALIZE TESTNET') { throw 'Confirmation did not match; no transaction sent.' }
}

# Fetch the latest finalized block timestamp only after all checks and confirmation.
$block = Invoke-Rpc @{ jsonrpc='2.0'; id='ajo-preflight'; method='block'; params=@{ finality='final' } }
if ($block.error) { throw "Latest block query failed: $($block.error | ConvertTo-Json -Compress)" }
$deadline = [long]::Parse([string]$block.result.header.timestamp_nanosec) + [long]900000000000
$init = [ordered]@{
    members = $Members
    contribution_amount = $Contribution
    payout_order = $Members
    round_deadline = $deadline
    treasurer_agent = $Contract
    mode = 'ProtectedPublic'
}
$json = $init | ConvertTo-Json -Depth 8
Set-Content -LiteralPath $ArgsPath -Value $json -Encoding utf8

$command = "near contract deploy $Contract use-file `"$Wasm`" with-init-call new file-args `"$ArgsPath`" prepaid-gas '200 TGas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain --signer-public-key '$SignerPublicKey' send"
Write-Host "WASM SHA-256: $actualSha"
Write-Host "Latest finalized block: $($block.result.header.height)"
Write-Host "Round 1 deadline (ns): $deadline (15 minutes after that block timestamp)"
Write-Host 'Initialization JSON:'
Write-Host $json
Write-Host 'Exact near-cli-rs command:'
Write-Host $command
if (-not $Execute) {
    Write-Host 'DRY RUN ONLY: no transaction sent. Run this script with -Execute only after reviewing the exact command and explicitly authorizing deployment + initialization.'
    exit 0
}

# No sleeps or extra steps between fetching the fresh timestamp and invoking near-cli-rs.
$cliArgs = @('contract','deploy',$Contract,'use-file',$Wasm,'with-init-call','new','file-args',$ArgsPath,'prepaid-gas','200 TGas','attached-deposit','0 NEAR','network-config','testnet','sign-with-keychain','--signer-public-key',$SignerPublicKey,'send')
& near @cliArgs
if ($LASTEXITCODE -ne 0) { throw "near-cli-rs failed with exit code $LASTEXITCODE. Check transaction status before retrying; do not blindly resubmit." }
