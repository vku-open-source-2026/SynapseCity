# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
#
# Build the release APK from a short Windows path. Expo/React Native native
# codegen can exceed the legacy 260-character MAX_PATH when the checkout lives
# under a long directory. The source of truth stays in this repository; this
# script mirrors it to C:\q, links a short node_modules store and builds.
$ErrorActionPreference = 'Stop'

$source = Split-Path -Parent $PSScriptRoot
$short = 'C:\q'
$store = 'C:\n\node_modules'
$dist = Join-Path $source 'dist'
$gradle = Join-Path $short 'android\gradlew.bat'
$apk = Join-Path $short 'android\app\build\outputs\apk\release\app-release-unsigned.apk'

New-Item -ItemType Directory -Force -Path $short, $dist, 'C:\n' | Out-Null

Write-Host "Mirroring $source -> $short"
& robocopy $source $short /E /XD node_modules .expo dist .git android\app\.cxx android\app\build android\build /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) { throw "robocopy failed with exit code $LASTEXITCODE" }

if (-not (Test-Path $store)) {
    Write-Host 'Installing dependencies in the short build directory'
    Push-Location $short
    try { npm ci } finally { Pop-Location }
    Move-Item (Join-Path $short 'node_modules') $store
}

$link = Join-Path $short 'node_modules'
if (Test-Path $link) { cmd /c rmdir $link }
cmd /c mklink /J $link $store | Out-Null

$env:JAVA_HOME = Join-Path $env:USERPROFILE 'android-tools\jdk17'
$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"

Write-Host 'Building release APK'
& cmd /c "`"$gradle`" -p `"$short\android`" :app:assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a,x86_64 -Pexpo.signing.skip=true > `"$dist\build.log`" 2>&1"
if ($LASTEXITCODE -ne 0) { throw "Gradle failed; see $dist\build.log" }
if (-not (Test-Path $apk)) { throw "APK not found at $apk" }

$version = (Get-Content (Join-Path $source 'app.json') -Raw | ConvertFrom-Json).expo.version
$target = Join-Path $dist "SynapseCity-$version-release.apk"
Copy-Item $apk $target -Force
$hash = (Get-FileHash $target -Algorithm SHA256).Hash
Write-Host "APK: $target"
Write-Host "SHA-256: $hash"
