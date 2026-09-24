#!/usr/bin/env pwsh
node (Join-Path $PSScriptRoot 'src\minagent.mjs') @args
exit $LASTEXITCODE
