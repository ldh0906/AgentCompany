#!/usr/bin/env node
// 진입점. node:sqlite 실험 경고만 숨기고 나머지는 동적으로 불러온다.
const originalEmit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('SQLite')) return;
  return (originalEmit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import('./commands.ts');
await main(process.argv.slice(2));
