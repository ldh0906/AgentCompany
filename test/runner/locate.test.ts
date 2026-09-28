import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shimTarget } from '../../src/runner/locate.ts';

const NPM_CMD = `:: Created by npm, please don't edit manually.
@ECHO OFF
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"
SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"
FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (
  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"
)
"%NODE_EXE%" "%NPM_CLI_JS%" %*
`;

const CMD_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

test('실제 npm.cmd: npm-prefix.js가 아니라 npm-cli.js를 고른다 (검수에서 발견한 버그)', () => {
  assert.equal(shimTarget(NPM_CMD), 'node_modules\\npm\\bin\\npm-cli.js');
});

test('cmd-shim 형식: 실행 줄의 스크립트를 고른다', () => {
  assert.equal(shimTarget(CMD_SHIM), 'node_modules\\@openai\\codex\\bin\\codex.js');
});

test('스크립트가 없으면 null', () => {
  assert.equal(shimTarget('@echo off\r\nfoo.exe %*\r\n'), null);
});
