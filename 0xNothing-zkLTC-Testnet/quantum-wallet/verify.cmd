@echo off
setlocal EnableExtensions
rem One-shot verification for quantum-wallet Phases 0-3, Windows cmd.exe edition.
rem Each step runs on its own line (no && short-circuit), so a failure never stops
rem the rest; PASS/FAIL lines are appended to verify.log and echoed to console.
cd /d "%~dp0"
set "QW=%CD%"
set "LOG=%QW%\verify.log"
> "%LOG%" echo [verify %date% %time%]

echo.
echo ==== toolchain probe ====
node --version >nul 2>&1
if not errorlevel 1 (echo PASS  node & echo PASS  node>>"%LOG%") else (echo FAIL  node & echo FAIL  node>>"%LOG%")
forge --version >nul 2>&1
if not errorlevel 1 (echo PASS  forge & echo PASS  forge>>"%LOG%") else (echo FAIL  forge - not on PATH & echo FAIL  forge - not on PATH>>"%LOG%")
anvil --version >nul 2>&1
if not errorlevel 1 (echo PASS  anvil & echo PASS  anvil>>"%LOG%") else (echo INFO  anvil missing - e2e will self-skip & echo INFO  anvil missing>>"%LOG%")

echo.
echo ==== 1) junction node_modules -^> apps/web/node_modules ====
if exist "%QW%\node_modules" (
  echo PASS  node_modules already present
  echo PASS  node_modules already present>>"%LOG%"
) else (
  mklink /J "%QW%\node_modules" "c:\Users\tdat\Desktop\0xnothing\0xNothing-zkLTC-Testnet\apps\web\node_modules" >nul 2>&1
  if not errorlevel 1 (echo PASS  junction created & echo PASS  junction created>>"%LOG%") else (echo SKIP  junction - nodehooks.mjs covers node runs & echo SKIP  junction>>"%LOG%")
)

echo.
echo ==== 2) SDK tests ====
pushd "%QW%\sdk"
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ../nodehooks.mjs --test --experimental-strip-types test\*.test.ts >>"%LOG%" 2>&1
if not errorlevel 1 (echo PASS  sdk tests & echo PASS  sdk tests>>"%LOG%") else (echo FAIL  sdk tests - see verify.log & echo FAIL  sdk tests>>"%LOG%")
popd

echo.
echo ==== 3) generate cross-language vectors ====
pushd "%QW%\sdk"
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ../nodehooks.mjs --experimental-strip-types test\vectors.gen.ts >>"%LOG%" 2>&1
if not errorlevel 1 (echo PASS  vectors generated & echo PASS  vectors generated>>"%LOG%") else (echo FAIL  vectors generation & echo FAIL  vectors generation>>"%LOG%")
popd

echo.
echo ==== 4) forge build ====
pushd "%QW%\contracts"
forge build >>"%LOG%" 2>&1
if not errorlevel 1 (echo PASS  forge build & echo PASS  forge build>>"%LOG%") else (echo FAIL  forge build & echo FAIL  forge build>>"%LOG%")
popd

echo.
echo ==== 5) forge test ====
pushd "%QW%\contracts"
forge test -vv >>"%LOG%" 2>&1
if not errorlevel 1 (echo PASS  forge test & echo PASS  forge test>>"%LOG%") else (echo FAIL  forge test & echo FAIL  forge test>>"%LOG%")
popd

echo.
echo ==== 6) relayer policy tests ====
pushd "%QW%\relayer"
call npm test >>"%LOG%" 2>&1
if not errorlevel 1 (echo PASS  relayer policy tests & echo PASS  relayer policy tests>>"%LOG%") else (echo FAIL  relayer policy tests & echo FAIL  relayer policy tests>>"%LOG%")
popd

echo.
echo ==== 7) relayer anvil e2e (self-skips if anvil/artifacts missing) ====
pushd "%QW%\relayer"
node --import ../nodehooks.mjs --experimental-strip-types test\e2e.ts >>"%LOG%" 2>&1
if not errorlevel 1 (echo PASS  anvil e2e & echo PASS  anvil e2e>>"%LOG%") else (echo FAIL  anvil e2e - see verify.log & echo FAIL  anvil e2e>>"%LOG%")
popd

echo.
echo ==== SUMMARY ====
echo Full log: %LOG%
type "%LOG%"
endlocal
