[CmdletBinding()]
param(
  [string]$Root
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$leanProjectRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = $leanProjectRoot
}
$scanRoot = (Resolve-Path -LiteralPath $Root).Path
$pathSeparators = [char[]]@('\', '/')
$scanPrefix = $scanRoot.TrimEnd($pathSeparators)
$lakeCommand = 'lake'
$toolchainFile = Join-Path $leanProjectRoot 'lean-toolchain'
if (Test-Path -LiteralPath $toolchainFile) {
  $toolchainName = [System.IO.File]::ReadAllText($toolchainFile).Trim()
  $toolchainDirectory = $toolchainName.Replace('/', '--').Replace(':', '---')
  $elanHome = if ($env:ELAN_HOME) {
    $env:ELAN_HOME
  } elseif ($env:USERPROFILE) {
    Join-Path $env:USERPROFILE '.elan'
  } else {
    Join-Path ([Environment]::GetFolderPath('UserProfile')) '.elan'
  }
  $lakeExecutable = if ([Environment]::OSVersion.Platform -eq 'Win32NT') {
    'lake.exe'
  } else {
    'lake'
  }
  $pinnedLake = Join-Path $elanHome "toolchains/$toolchainDirectory/bin/$lakeExecutable"
  if (Test-Path -LiteralPath $pinnedLake) {
    $lakeCommand = $pinnedLake
  }
}
$forbiddenTokens = @{
  admit = $true
  axiom = $true
  sorry = $true
  unsafe = $true
}

function Test-LeanIdentifierCharacter {
  param([char]$Character)

  return [char]::IsLetterOrDigit($Character) -or
    $Character -eq '_' -or
    $Character -eq "'" -or
    $Character -eq '?' -or
    $Character -eq '!'
}

$findings = [System.Collections.Generic.List[object]]::new()
$leanFiles = Get-ChildItem -LiteralPath $scanRoot -Recurse -File -Filter '*.lean' |
  Sort-Object -Property FullName
$scannedFileCount = 0

foreach ($file in $leanFiles) {
  $relativePath = $file.FullName.Substring($scanPrefix.Length).TrimStart($pathSeparators)
  $relativePath = $relativePath.Replace('\', '/')
  if (($relativePath -split '[/\\]') -contains '.lake') {
    continue
  }
  $scannedFileCount++

  $source = [System.IO.File]::ReadAllText($file.FullName)
  $index = 0
  $line = 1
  $state = 'code'
  $blockCommentDepth = 0

  :scan while ($index -lt $source.Length) {
    $character = $source[$index]
    $hasNext = $index + 1 -lt $source.Length
    $nextCharacter = if ($hasNext) { $source[$index + 1] } else { [char]0 }

    switch ($state) {
      'line-comment' {
        if ($character -eq "`n") {
          $line++
          $state = 'code'
        }
        $index++
        continue scan
      }

      'block-comment' {
        if ($character -eq '/' -and $hasNext -and $nextCharacter -eq '-') {
          $blockCommentDepth++
          $index += 2
          continue scan
        }
        if ($character -eq '-' -and $hasNext -and $nextCharacter -eq '/') {
          $blockCommentDepth--
          $index += 2
          if ($blockCommentDepth -eq 0) {
            $state = 'code'
          }
          continue scan
        }
        if ($character -eq "`n") {
          $line++
        }
        $index++
        continue scan
      }

      'string' {
        if ($character -eq '\' -and $hasNext) {
          if ($nextCharacter -eq "`n") {
            $line++
          }
          $index += 2
          continue scan
        }
        if ($character -eq '"') {
          $state = 'code'
        } elseif ($character -eq "`n") {
          $line++
        }
        $index++
        continue scan
      }

      'character' {
        if ($character -eq '\' -and $hasNext) {
          if ($nextCharacter -eq "`n") {
            $line++
          }
          $index += 2
          continue scan
        }
        if ($character -eq "'") {
          $state = 'code'
        } elseif ($character -eq "`n") {
          $line++
          $state = 'code'
        }
        $index++
        continue scan
      }
    }

    if ($character -eq '-' -and $hasNext -and $nextCharacter -eq '-') {
      $state = 'line-comment'
      $index += 2
      continue
    }
    if ($character -eq '/' -and $hasNext -and $nextCharacter -eq '-') {
      $state = 'block-comment'
      $blockCommentDepth = 1
      $index += 2
      continue
    }
    if ($character -eq '"') {
      $state = 'string'
      $index++
      continue
    }
    if ($character -eq "'" -and
        ($index -eq 0 -or -not (Test-LeanIdentifierCharacter $source[$index - 1]))) {
      $state = 'character'
      $index++
      continue
    }
    if (Test-LeanIdentifierCharacter $character) {
      $tokenLine = $line
      $tokenStart = $index
      while ($index -lt $source.Length -and
          (Test-LeanIdentifierCharacter $source[$index])) {
        $index++
      }
      $token = $source.Substring($tokenStart, $index - $tokenStart)
      if ($forbiddenTokens.ContainsKey($token)) {
        $findings.Add([pscustomobject]@{
            Path = $relativePath
            Line = $tokenLine
            Token = $token
          })
      }
      continue
    }
    if ($character -eq "`n") {
      $line++
    }
    $index++
  }
}

if ($findings.Count -gt 0) {
  foreach ($finding in $findings) {
    Write-Output ("{0}:{1}: forbidden Lean declaration token '{2}'" -f
      $finding.Path, $finding.Line, $finding.Token)
  }
  exit 1
}

Write-Output ("Lean trust scan passed for {0} project source file(s)." -f $scannedFileCount)

Push-Location -LiteralPath $leanProjectRoot
try {
  & $lakeCommand build --wfail
  $buildExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

exit $buildExitCode
