// "Agent Company.exe" 만들기(Windows): npm run build 다음에 npm run build:exe.
// Windows에 들어 있는 C# 컴파일러(csc.exe, .NET Framework 4)로 작은 실행 파일을 만든다. 아무것도 내려받지 않는다.
// 실행 파일은 node로 dist/cli/main.js를 켜는 일만 하므로 Node.js가 깔린 PC에서 동작한다.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const main = path.join(root, 'dist', 'cli', 'main.js');
if (!existsSync(main)) throw new Error('dist/cli/main.js가 없습니다. 먼저 npm run build를 실행하세요.');
const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(csc)) throw new Error(`C# 컴파일러를 찾지 못했습니다: ${csc}`);

const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version.replace(/[^0-9.]/g, '');
const source = readFileSync(path.join(root, 'tools', 'launcher', 'AgentCompany.cs'), 'utf8')
  .replaceAll('{{MAIN}}', main.replaceAll('"', '""'))
  .replaceAll('{{VERSION}}', `${version}.0`);
const tmp = path.join(root, 'dist', 'launcher.cs');
const out = path.join(root, 'dist', 'Agent Company.exe');
// BOM을 붙여야 csc가 한글 메시지를 UTF-8로 읽는다
writeFileSync(tmp, `\uFEFF${source}`);
try {
  execFileSync(
    csc,
    [
      '/nologo',
      '/target:winexe',
      '/optimize+',
      `/out:${out}`,
      `/win32icon:${path.join(root, 'web', 'public', 'icon.ico')}`,
      '/r:System.Windows.Forms.dll',
      tmp,
    ],
    { stdio: 'inherit', windowsHide: true },
  );
} finally {
  rmSync(tmp, { force: true });
}
console.log(`만들었습니다: ${out}`);
