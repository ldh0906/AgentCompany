// Agent Company 실행 파일(Windows): 콘솔 창 없이 앱을 켜고 전용 창을 연다. 이미 켜져 있으면 그 창만 연다.
// 바로가기(launch.vbs)와 같은 일을 한다: node <main.js> start --background
// tools/build-exe.ts가 {{MAIN}}을 만든 때의 main.js 경로로 바꿔 Windows에 들어 있는 csc.exe로 컴파일한다(내려받기 없음).
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("Agent Company")]
[assembly: AssemblyProduct("Agent Company")]
[assembly: AssemblyVersion("{{VERSION}}")]
[assembly: AssemblyFileVersion("{{VERSION}}")]

static class Program
{
    // 만든 때의 main.js 경로: exe를 바탕화면 등으로 옮겨도 동작하게
    const string BuiltMain = @"{{MAIN}}";

    [STAThread]
    static void Main(string[] args)
    {
        string main = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "cli", "main.js");
        if (!File.Exists(main)) main = BuiltMain;
        if (!File.Exists(main))
        {
            MessageBox.Show("Agent Company 프로그램 파일을 찾지 못했습니다:\n" + main + "\n\n프로그램 폴더에서 npm run build:exe 로 다시 만들어 주세요.", "Agent Company", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        string node = FindNode();
        if (node == null)
        {
            MessageBox.Show("Node.js를 찾지 못했습니다.\nhttps://nodejs.org 에서 설치한 뒤 다시 실행해 주세요.", "Agent Company", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        // 추가 인자(예: --data-dir D:\회사)는 그대로 넘긴다
        string extra = string.Join(" ", args.Select(Quote));
        var psi = new ProcessStartInfo(node, Quote(main) + " start --background " + extra)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(main),
        };
        try
        {
            Process.Start(psi);
        }
        catch (Exception e)
        {
            MessageBox.Show("Agent Company를 켜지 못했습니다:\n" + e.Message, "Agent Company", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static string FindNode()
    {
        foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try
            {
                string p = Path.Combine(dir.Trim().Trim('"'), "node.exe");
                if (dir.Trim().Length > 0 && File.Exists(p)) return p;
            }
            catch (ArgumentException) { }
        }
        string pf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        return File.Exists(pf) ? pf : null;
    }

    static string Quote(string s)
    {
        // 끝의 \는 닫는 따옴표를 가리므로 뗀다(예: --data-dir "D:\회사\")
        return "\"" + s.TrimEnd('\\').Replace("\"", "\\\"") + "\"";
    }
}
