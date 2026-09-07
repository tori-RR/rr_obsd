$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $project 'manifest.json') | ConvertFrom-Json
$dist = Join-Path $project 'dist'
$stage = Join-Path $dist ('stage-' + [guid]::NewGuid().ToString('N'))
$plugin = Join-Path $stage $manifest.id
$null = New-Item -ItemType Directory -Path (Join-Path $plugin 'native') -Force
foreach($name in @('main.js','manifest.json','README.md','LICENSE','CHANGELOG.md')) {
    Copy-Item -LiteralPath (Join-Path $project $name) -Destination $plugin
}
Copy-Item -LiteralPath (Join-Path $project 'native\watch.ps1') -Destination (Join-Path $plugin 'native')
Copy-Item -LiteralPath (Join-Path $project 'docs') -Destination (Join-Path $plugin 'docs') -Recurse
$zip = Join-Path $dist ('obsidian-vault-watch-' + $manifest.version + '.zip')
Compress-Archive -LiteralPath $plugin -DestinationPath $zip -Force
$resolvedStage = [IO.Path]::GetFullPath($stage)
$resolvedDist = [IO.Path]::GetFullPath($dist).TrimEnd('\') + '\'
if (!$resolvedStage.StartsWith($resolvedDist, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe staging path.' }
Remove-Item -LiteralPath $resolvedStage -Recurse -Force
$sha256 = [Security.Cryptography.SHA256]::Create()
$stream = [IO.File]::OpenRead($zip)
try { $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
finally { $stream.Dispose(); $sha256.Dispose() }
[pscustomobject]@{ Path = $zip; Bytes = (Get-Item -LiteralPath $zip).Length; SHA256 = $hash } | Format-List
