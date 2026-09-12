@echo off
setlocal EnableExtensions
rem Steps 4-5 of the pipeline ONLY: typecheck + build the extension dist.
rem
rem Windows cmd.exe companion to build-dist.sh. Typing `bash build-dist.sh` in
rem cmd or PowerShell resolves `bash` to the WSL launcher (C:\Windows\System32\
rem bash.exe), which needs virtualization this machine does not have -- it dies
rem with HCS_E_HYPERV_NOT_INSTALLED before ever reading the script. Run this
rem instead, or use Git Bash: "C:\Program Files\Git\bin\bash.exe" build-dist.sh.
rem
rem Deliberately does NOT run forge test or the deploy again: the factory is
rem already live on LiteForge and pinned in .env.local, and re-running
rem DeployFactory would burn gas to mint a SECOND, unrelated factory address
rem (breaking every wallet address already predicted from the first one).

cd /d "%~dp0"
set "QW=%CD%"
set "WALLET=c:\Users\tdat\Desktop\0xnothing\0xNothing-zkLTC-Testnet\apps\wallet"

if not exist "%QW%\.env.local" goto :noenv
if not exist "%WALLET%" goto :nowallet

rem Read ONLY QW_FACTORY out of .env.local. PRIVATE_KEY sits in the same file;
rem unlike the bash script (which sources the whole file and then unsets the
rem key) this never loads it into the environment at all, and never echoes it.
set "FACTORY="
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b /c:"QW_FACTORY=" "%QW%\.env.local"`) do set "FACTORY=%%B"
set FACTORY=%FACTORY:"=%
if not defined FACTORY goto :nofactory

> "%WALLET%\.env.local" echo VITE_QUANTUM_FACTORY=%FACTORY%
echo factory wired: %FACTORY%
echo.

echo == [1/3] typecheck the extension (wallet src + quantum SDK src) ==
pushd "%WALLET%"
call npm run typecheck
if errorlevel 1 goto :failed
popd

echo == [2/3] typecheck the relayer ==
rem The relayer runs under --experimental-strip-types, which STRIPS types without
rem checking them, and its tests import modules rather than executing main(). So a
rem missing import on the startup path survives every test and only explodes when
rem the server is launched. This step is the only thing that checks it.
pushd "%QW%\relayer"
call npm run typecheck
if errorlevel 1 goto :failed
popd

echo == [3/3] build the extension dist ==
pushd "%WALLET%"
call npm run build
if errorlevel 1 goto :failed
popd

echo.
echo DONE.
echo   factory : %FACTORY%
echo   dist    : %WALLET%\dist
echo   relayer : cd %QW%\relayer   then   npm start   (gas sponsor on 127.0.0.1:8787)
echo   load    : chrome://extensions , Developer mode , Load unpacked , %WALLET%\dist
goto :eof

:noenv
echo ERROR: %QW%\.env.local not found - it must define QW_FACTORY.
goto :failed

:nowallet
echo ERROR: wallet app not found at %WALLET%
goto :failed

:nofactory
echo ERROR: no QW_FACTORY= line found in %QW%\.env.local
echo        The factory is already deployed - do NOT re-run DeployFactory.
goto :failed

:failed
popd >nul 2>&1
echo.
echo BUILD FAILED.
exit /b 1
