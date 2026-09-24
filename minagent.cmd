@echo off
node "%~dp0src\minagent.mjs" %*
exit /b %ERRORLEVEL%
