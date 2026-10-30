using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MinePilot
{
    internal static class Program
    {
        private static string logPath;

        [DllImport("shell32.dll", EntryPoint = "ShellExecuteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr ShellExecute(
            IntPtr hwnd, string lpOperation, string lpFile, string lpParameters,
            string lpDirectory, int nShowCmd);

        [STAThread]
        private static int Main(string[] args)
        {
            // server.js 用同一个可执行文件打开目录/链接：
            //   MinePilot.exe --open "C:\path" / "https://..."
            // 这样可以复用已存在的程序，不需要额外附带一个容易被安全软件拦截的小 exe。
            if (args.Length >= 2 && string.Equals(args[0], "--open", StringComparison.OrdinalIgnoreCase))
            {
                return OpenWithShell(args[1]);
            }

            try
            {
                Launch();
                return 0;
            }
            catch (Exception ex)
            {
                Fail("启动器初始化失败：\r\n" + ex.Message);
                return 1;
            }
        }

        private static int OpenWithShell(string target)
        {
            if (string.IsNullOrWhiteSpace(target)) return 1;
            bool isUrl = target.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                || target.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
            if (!isUrl && !File.Exists(target) && !Directory.Exists(target)) return 3;

            try
            {
                // ShellExecuteW 直接交给 Windows 的默认关联程序，立即返回；
                // 不用 Process.Start，避免某些环境下它一直占着子进程导致调用方等待。
                IntPtr result = ShellExecute(IntPtr.Zero, "open", target, null, null, 1);
                return result.ToInt64() > 32 ? 0 : 5;
            }
            catch
            {
                return 2;
            }
        }

        private static void Log(string message)
        {
            try
            {
                if (logPath == null)
                {
                    logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "bootstrap.log");
                }
                File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + "\r\n", Encoding.UTF8);
            }
            catch
            {
                // 日志失败不影响启动
            }
        }

        private static void Launch()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            string node = Path.Combine(baseDir, "runtime", "node", "node.exe");
            string server = Path.Combine(baseDir, "server.js");
            string starter = Path.Combine(baseDir, "start-server.cmd");
            Log("bootstrap start: " + baseDir);

            if (!File.Exists(node))
            {
                Fail("未找到内置 Node 运行时：\r\n" + node);
                return;
            }
            if (!File.Exists(server))
            {
                Fail("未找到服务端文件：\r\n" + server);
                return;
            }
            if (!File.Exists(starter))
            {
                Fail("未找到启动脚本：\r\n" + starter);
                return;
            }

            int port = FindFreePort();
            string logFile = Path.Combine(baseDir, "server.log");
            Log("free port: " + port.ToString());

            ProcessStartInfo serverInfo = new ProcessStartInfo(
                Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                "/c start-server.cmd " + port.ToString());
            serverInfo.WorkingDirectory = baseDir;
            serverInfo.UseShellExecute = false;
            serverInfo.CreateNoWindow = true;
            serverInfo.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(serverInfo);
            Log("server command started");

            if (!WaitForServer(port, 30))
            {
                Fail("本地服务没有在 30 秒内启动。\r\n\r\n最近日志：\r\n" + ReadTail(logFile, 2500));
                return;
            }
            Log("server healthy");

            string edge = FindEdge();
            if (edge == null)
            {
                Fail("未找到 Microsoft Edge。\r\n请确认 Edge 已安装，或使用 README 中的 Electron 版本。");
                return;
            }
            Log("edge: " + edge);

            string profile = Environment.GetEnvironmentVariable("MINEPILOT_EDGE_PROFILE");
            string url = "http://127.0.0.1:" + port.ToString() + "/?web=1";
            string args = "--app=" + url
                + " --no-first-run --no-default-browser-check"
                + " --disable-sync --disable-features=msEdgeSidebarV2";
            if (!string.IsNullOrEmpty(profile))
            {
                Directory.CreateDirectory(profile);
                args += " --user-data-dir=\"" + profile + "\"";
            }
            Log("starting edge: " + args);

            ProcessStartInfo edgeInfo = new ProcessStartInfo(edge, args);
            edgeInfo.UseShellExecute = false;
            edgeInfo.WorkingDirectory = baseDir;
            Process edgeProcess = Process.Start(edgeInfo);
            if (edgeProcess == null)
            {
                Fail("Edge 启动失败。");
                return;
            }
            Log("edge started pid=" + edgeProcess.Id.ToString());

            if (!WaitForClient(port, 25))
            {
                Fail("Edge 窗口没有连接到启动器。\r\n请确认 Edge 能正常打开网页，或查看 server.log。");
                return;
            }
            Log("edge connected");
            Log("bootstrap done");
        }

        private static int FindFreePort()
        {
            TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            return port;
        }

        private static bool WaitForServer(int port, int seconds)
        {
            string url = "http://127.0.0.1:" + port.ToString() + "/health";
            for (int i = 0; i < seconds * 2; i++)
            {
                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                    request.Proxy = null;
                    request.Timeout = 700;
                    request.ReadWriteTimeout = 700;
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    {
                        if ((int)response.StatusCode == 200) return true;
                    }
                }
                catch
                {
                    // 服务还没起来，继续等待
                }
                Thread.Sleep(500);
            }
            return false;
        }

        private static bool WaitForClient(int port, int seconds)
        {
            string url = "http://127.0.0.1:" + port.ToString() + "/api/status";
            for (int i = 0; i < seconds * 2; i++)
            {
                try
                {
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                    request.Proxy = null;
                    request.Timeout = 700;
                    request.ReadWriteTimeout = 700;
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                    {
                        string body = reader.ReadToEnd();
                        if (body.IndexOf("\"connected\":true", StringComparison.Ordinal) >= 0) return true;
                    }
                }
                catch
                {
                    // 页面还没连上，继续等待
                }
                Thread.Sleep(500);
            }
            return false;
        }

        private static string FindEdge()
        {
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                    "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Microsoft", "Edge", "Application", "msedge.exe"),
            };
            foreach (string candidate in candidates)
            {
                if (!string.IsNullOrEmpty(candidate) && File.Exists(candidate)) return candidate;
            }

            string[] keys = new string[]
            {
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
                @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
            };
            foreach (string keyName in keys)
            {
                try
                {
                    using (RegistryKey key = Registry.LocalMachine.OpenSubKey(keyName))
                    {
                        if (key == null) continue;
                        string value = key.GetValue(null) as string;
                        if (!string.IsNullOrEmpty(value) && File.Exists(value)) return value;
                    }
                }
                catch
                {
                    // 忽略注册表读取失败
                }
            }
            return null;
        }

        private static string ReadTail(string file, int maxBytes)
        {
            try
            {
                if (!File.Exists(file)) return "（没有日志文件）";
                using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    long start = Math.Max(0, stream.Length - maxBytes);
                    stream.Seek(start, SeekOrigin.Begin);
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        return reader.ReadToEnd();
                    }
                }
            }
            catch (Exception ex)
            {
                return "（读取日志失败：" + ex.Message + "）";
            }
        }

        private static void Fail(string message)
        {
            Log("ERROR: " + message);
            if (Environment.GetEnvironmentVariable("MINEPILOT_NO_DIALOG") == "1") return;
            MessageBox.Show(message, "MinePilot 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}