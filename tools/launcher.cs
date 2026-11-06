using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

// fuda 启动器（对外名字就是 fuda.exe，真正跑 Electron 的是 fuda-core.exe）
// 需要它的两个原因：
//   1) 部分 Windows 会话里 Chromium 沙箱初始化会静默失败（进程无输出、退出码 0x80000003），
//      表现为"双击没反应"。先按正常方式启动，1 秒内就死了，再自动带 --no-sandbox 重试。
//   2) 机器上若有全局 ELECTRON_RUN_AS_NODE=1，Electron 会退化成纯 Node 并把参数当非法选项
//      秒退。启动前必须从环境里删掉它（置空字符串仍然算存在）。
internal static class Launcher
{
    private const string CoreExe = "fuda-core.exe";

    [STAThread]
    private static int Main(string[] args)
    {
        string dir = Path.GetDirectoryName(typeof(Launcher).Assembly.Location);
        string exe = Path.Combine(dir, CoreExe);
        if (!File.Exists(exe))
        {
            MessageBox.Show(
                "同目录下找不到 " + CoreExe + "：\r\n" + dir,
                "浮答 启动失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }

        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", null, EnvironmentVariableTarget.Process);

        // 第一轮：完全按正常方式启动（保留 Chromium 沙箱）
        Process first = TryStart(exe, dir, args);
        if (first == null)
        {
            return 1;
        }
        if (!first.WaitForExit(2500))
        {
            // 还活着 = 启动成功
            return 0;
        }
        if (first.ExitCode == 0)
        {
            // 正常退出（用户秒关），不算失败
            return 0;
        }

        // 第二轮：沙箱起不来时 Chromium 会直接死，补上 --no-sandbox 再试
        Process second = TryStart(exe, dir, args, "--no-sandbox");
        if (second == null)
        {
            return 1;
        }
        if (!second.WaitForExit(6000) || second.ExitCode == 0)
        {
            return 0;
        }

        string log = Path.Combine(dir, ".user-data", "startup.log");
        string detail = File.Exists(log) ? File.ReadAllText(log) : "(没有生成 startup.log，说明 Electron 内核在运行 JS 之前就退出了)";
        if (detail.Length > 1800)
        {
            detail = detail.Substring(detail.Length - 1800);
        }
        MessageBox.Show(
            "浮答 启动后立即退出。\r\n\r\n" +
            "第一次退出码：" + first.ExitCode + "\r\n" +
            "第二次（--no-sandbox）退出码：" + second.ExitCode + "\r\n\r\n" +
            "日志：" + log + "\r\n\r\n" + detail,
            "浮答 启动失败",
            MessageBoxButtons.OK,
            MessageBoxIcon.Error);
        return second.ExitCode;
    }

    private static Process TryStart(string exe, string dir, string[] args, params string[] extra)
    {
        StringBuilder argLine = new StringBuilder();
        foreach (string e in extra)
        {
            argLine.Append(e);
            argLine.Append(' ');
        }
        foreach (string a in args)
        {
            argLine.Append('"');
            argLine.Append(a);
            argLine.Append("\" ");
        }

        ProcessStartInfo psi = new ProcessStartInfo(exe, argLine.ToString().Trim());
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;

        try
        {
            return Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "无法启动 " + CoreExe + "：\r\n" + ex.Message,
                "浮答 启动失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return null;
        }
    }
}
