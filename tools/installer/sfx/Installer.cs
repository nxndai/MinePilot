using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyVersion("__VERSION__.0")]
[assembly: AssemblyFileVersion("__VERSION__.0")]
[assembly: AssemblyTitle("MinePilot 安装程序")]
[assembly: AssemblyDescription("MinePilot Minecraft 启动器安装程序")]
[assembly: AssemblyProduct("MinePilot")]
[assembly: AssemblyCompany("MinePilot")]

namespace MinePilotSetup
{
    internal static class Program
    {
        private const string Marker = "MPPAYLOAD1";
        private const string Version = "__VERSION__";
        private static string logPath;
        private static string currentTarget;

        [STAThread]
        private static int Main(string[] args)
        {
            bool silent = HasArg(args, "/S") || HasArg(args, "/silent") || HasArg(args, "--silent");
            try
            {
                string self = Application.ExecutablePath;
                logPath = Path.Combine(Path.GetTempPath(), "MinePilotSetup.log");
                if (string.Equals(Path.GetFileName(self), "Uninstall.exe", StringComparison.OrdinalIgnoreCase)
                    || HasArg(args, "/CLEANUP"))
                {
                    return Uninstall(self, silent, args);
                }
                return Install(self, silent, GetArgValue(args, "/DIR="));
            }
            catch (Exception ex)
            {
                Log("失败：" + ex);
                if (!string.IsNullOrEmpty(currentTarget))
                {
                    try
                    {
                        Directory.CreateDirectory(currentTarget);
                        File.WriteAllText(Path.Combine(currentTarget, "setup-error.txt"), ex.ToString(), Encoding.UTF8);
                    }
                    catch
                    {
                    }
                }
                if (!silent)
                {
                    MessageBox.Show("MinePilot 安装失败：\r\n" + ex.Message, "MinePilot", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                return 1;
            }
        }

        private static string GetArgValue(string[] args, string prefix)
        {
            foreach (string arg in args)
            {
                if (arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    return arg.Substring(prefix.Length).Trim().Trim('"');
                }
            }
            return "";
        }

        private static bool HasArg(string[] args, string expected)
        {
            foreach (string arg in args)
            {
                if (string.Equals(arg, expected, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static int Install(string self, bool silent, string customTarget)
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string target = string.IsNullOrWhiteSpace(customTarget)
                ? Path.Combine(local, "Programs", "MinePilot")
                : Path.GetFullPath(customTarget);
            string exePath = Path.Combine(target, "MinePilot.exe");

            if (!silent)
            {
                DialogResult answer = MessageBox.Show(
                    "MinePilot 将安装到：\r\n" + target + "\r\n\r\n安装包不包含账户、设置或游戏数据；升级时 data 目录会被保留。\r\n\r\n继续安装吗？",
                    "安装 MinePilot " + Version,
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question);
                if (answer != DialogResult.Yes) return 0;
            }

            currentTarget = target;
            Log("开始安装 " + Version + " 到 " + target);
            KillRunning();
            Directory.CreateDirectory(target);
            WriteStep(target, "创建目录完成");

            // 不使用 %TEMP%：部分受限账户/计划任务下临时目录不可写；放到目标目录内更可靠。
            string temp = Path.Combine(target, ".minepilot-install-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            string zipPath = Path.Combine(temp, "payload.zip");
            string appDir = Path.Combine(temp, "app");
            try
            {
                WriteStep(target, "读取安装数据");
                ExtractPayload(self, zipPath);
                WriteStep(target, "解压安装数据");
                Directory.CreateDirectory(appDir);
                ZipFile.ExtractToDirectory(zipPath, appDir);
                WriteStep(target, "复制程序文件");
                CopyDirectory(appDir, target);
                if (!File.Exists(exePath))
                {
                    throw new IOException("安装包中没有找到 MinePilot.exe。");
                }
                try
                {
                    CreateShortcuts(target, exePath);
                }
                catch (Exception shortcutError)
                {
                    // 受限账户/企业策略可能禁止写入开始菜单；安装本身不应因此失败。
                    Log("创建快捷方式失败：" + shortcutError.Message);
                }
                try
                {
                    WriteRegistry(target, exePath);
                }
                catch (Exception registryError)
                {
                    Log("写入卸载信息失败：" + registryError.Message);
                }
                Log("安装完成");
                try { File.Delete(Path.Combine(target, "setup.log")); } catch { }
                try { File.Delete(Path.Combine(target, "setup-error.txt")); } catch { }
            }
            finally
            {
                TryDeleteDirectory(temp);
            }

            if (!silent)
            {
                DialogResult launch = MessageBox.Show(
                    "MinePilot " + Version + " 已安装完成。\r\n\r\n是否现在启动？",
                    "安装完成",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Information);
                if (launch == DialogResult.Yes)
                {
                    Process.Start(new ProcessStartInfo(exePath, "--no-sandbox")
                    {
                        WorkingDirectory = target,
                        UseShellExecute = true
                    });
                }
            }
            return 0;
        }

        private static void ExtractPayload(string self, string zipPath)
        {
            using (FileStream input = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                long total = input.Length;
                if (total < Marker.Length + 8 + 22)
                {
                    throw new InvalidDataException("安装包不完整：缺少内嵌数据。");
                }
                input.Position = total - Marker.Length - 8;
                byte[] tail = new byte[Marker.Length + 8];
                ReadExactly(input, tail, tail.Length);
                string marker = Encoding.ASCII.GetString(tail, 8, Marker.Length);
                if (!string.Equals(marker, Marker, StringComparison.Ordinal)) 
                {
                    throw new InvalidDataException("安装包校验失败：找不到数据标记。");
                }
                long length = BitConverter.ToInt64(tail, 0);
                long start = total - Marker.Length - 8 - length;
                if (length <= 0 || start <= 0)
                {
                    throw new InvalidDataException("安装包数据长度无效。");
                }
                input.Position = start;
                using (FileStream output = File.Create(zipPath))
                {
                    CopyBytes(input, output, length);
                }
            }
        }

        private static void ReadExactly(Stream stream, byte[] buffer, int count)
        {
            int offset = 0;
            while (offset < count)
            {
                int read = stream.Read(buffer, offset, count - offset);
                if (read <= 0) throw new EndOfStreamException();
                offset += read;
            }
        }

        private static void CopyBytes(Stream input, Stream output, long count)
        {
            byte[] buffer = new byte[1024 * 1024];
            long remaining = count;
            while (remaining > 0)
            {
                int want = (int)Math.Min(buffer.Length, remaining);
                int read = input.Read(buffer, 0, want);
                if (read <= 0) throw new EndOfStreamException();
                output.Write(buffer, 0, read);
                remaining -= read;
            }
        }

        private static void CopyDirectory(string source, string target)
        {
            Directory.CreateDirectory(target);
            foreach (string dir in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
            {
                string relative = dir.Substring(source.Length).TrimStart(Path.DirectorySeparatorChar);
                if (relative.Split(Path.DirectorySeparatorChar)[0].Equals("data", StringComparison.OrdinalIgnoreCase)) continue;
                Directory.CreateDirectory(Path.Combine(target, relative));
            }
            foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
            {
                string relative = file.Substring(source.Length).TrimStart(Path.DirectorySeparatorChar);
                if (relative.Split(Path.DirectorySeparatorChar)[0].Equals("data", StringComparison.OrdinalIgnoreCase)) continue;
                string destination = Path.Combine(target, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                File.Copy(file, destination, true);
            }
        }

        private static void CreateShortcuts(string target, string exePath)
        {
            string icon = Path.Combine(target, "MinePilot.ico");
            string desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "MinePilot.lnk");
            string programs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "MinePilot");
            Directory.CreateDirectory(programs);
            CreateShortcut(desktop, target, exePath, icon, "MinePilot Minecraft 启动器");
            CreateShortcut(Path.Combine(programs, "MinePilot.lnk"), target, exePath, icon, "MinePilot Minecraft 启动器");
            CreateShortcut(Path.Combine(programs, "卸载 MinePilot.lnk"), target, Path.Combine(target, "Uninstall.exe"), icon, "卸载 MinePilot");
        }

        private static void CreateShortcut(string path, string working, string target, string icon, string description)
        {
            object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            object shortcut = shell.GetType().InvokeMember(
                "CreateShortcut",
                BindingFlags.InvokeMethod,
                null,
                shell,
                new object[] { path });
            Type type = shortcut.GetType();
            type.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
            type.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { working });
            type.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { description });
            if (File.Exists(icon))
            {
                type.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { icon + ",0" });
            }
            if (Path.GetFileName(target).Equals("MinePilot.exe", StringComparison.OrdinalIgnoreCase))
            {
                type.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { "--no-sandbox" });
            }
            type.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }

        private static void WriteRegistry(string target, string exePath)
        {
            string uninstall = Path.Combine(target, "Uninstall.exe");
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\MinePilot"))
            {
                key.SetValue("DisplayName", "MinePilot");
                key.SetValue("DisplayVersion", Version);
                key.SetValue("Publisher", "MinePilot");
                key.SetValue("InstallLocation", target);
                key.SetValue("DisplayIcon", exePath + ",0");
                key.SetValue("UninstallString", "\"" + uninstall + "\"");
                key.SetValue("QuietUninstallString", "\"" + uninstall + "\" /S");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                try
                {
                    key.SetValue("EstimatedSize", DirectorySize(target) / 1024, RegistryValueKind.DWord);
                }
                catch
                {
                }
            }
        }

        private static long DirectorySize(string directory)
        {
            long total = 0;
            try
            {
                foreach (string file in Directory.GetFiles(directory, "*", SearchOption.AllDirectories))
                {
                    try { total += new FileInfo(file).Length; } catch { }
                }
            }
            catch
            {
            }
            return total;
        }

        private static int Uninstall(string self, bool silent, string[] args)
        {
            string dir = Path.GetDirectoryName(self);
            bool cleanupMode = HasArg(args, "/CLEANUP");
            string explicitDir = GetArgValue(args, "/DIR=");
            if (cleanupMode && !string.IsNullOrWhiteSpace(explicitDir))
            {
                dir = Path.GetFullPath(explicitDir);
            }

            if (!cleanupMode)
            {
                if (!silent)
                {
                    DialogResult answer = MessageBox.Show(
                        "确定要卸载 MinePilot 吗？\r\n\r\n账户、设置和游戏数据所在的 data 目录会被保留。",
                        "卸载 MinePilot",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Warning);
                    if (answer != DialogResult.Yes) return 0;
                }
                Log("开始卸载 " + dir);
                KillRunning();
                string helper = CopyUninstaller(self, dir);
                if (helper != null)
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo(helper, "/S /CLEANUP /DIR=\"" + dir + "\"")
                        {
                            WorkingDirectory = Path.GetDirectoryName(helper),
                            CreateNoWindow = true,
                            UseShellExecute = false
                        });
                        return 0;
                    }
                    catch (Exception launchError)
                    {
                        Log("启动卸载清理程序失败：" + launchError.Message);
                    }
                }
                cleanupMode = true;
            }

            if (cleanupMode)
            {
                // 等原卸载进程退出，避免 Uninstall.exe 被占用。
                System.Threading.Thread.Sleep(1200);
            }
            KillRunning();
            DeleteShortcuts();
            try
            {
                Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\MinePilot", false);
            }
            catch
            {
            }

            try
            {
                foreach (string file in Directory.GetFiles(dir))
                {
                    if (string.Equals(file, self, StringComparison.OrdinalIgnoreCase)) continue;
                    try { File.Delete(file); } catch { }
                }
                foreach (string child in Directory.GetDirectories(dir))
                {
                    if (Path.GetFileName(child).Equals("data", StringComparison.OrdinalIgnoreCase)) continue;
                    try { Directory.Delete(child, true); } catch { }
                }
                if (!Directory.Exists(Path.Combine(dir, "data")))
                {
                    try { Directory.Delete(dir, false); } catch { }
                }
            }
            catch
            {
            }

            try
            {
                string command = "/c ping 127.0.0.1 -n 2 >nul & del /f /q \"" + self + "\"";
                Process.Start(new ProcessStartInfo("cmd.exe", command)
                {
                    CreateNoWindow = true,
                    UseShellExecute = false
                });
            }
            catch
            {
            }

            if (!silent && !cleanupMode)
            {
                MessageBox.Show("MinePilot 已卸载，data 目录已保留。", "卸载完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            return 0;
        }

        private static string CopyUninstaller(string self, string dir)
        {
            string name = "MinePilotUninstall-" + Guid.NewGuid().ToString("N") + ".exe";
            string[] candidates = new string[]
            {
                Path.Combine(Path.GetTempPath(), name),
                Path.Combine(Path.GetDirectoryName(dir), name)
            };
            foreach (string candidate in candidates)
            {
                try
                {
                    File.Copy(self, candidate, true);
                    return candidate;
                }
                catch
                {
                }
            }
            return null;
        }

        private static void DeleteShortcuts()
        {
            string desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "MinePilot.lnk");
            try { File.Delete(desktop); } catch { }
            string programs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "MinePilot");
            try
            {
                if (Directory.Exists(programs)) Directory.Delete(programs, true);
            }
            catch
            {
            }
        }

        private static void KillRunning()
        {
            foreach (Process process in Process.GetProcessesByName("MinePilot"))
            {
                try
                {
                    process.Kill();
                    process.WaitForExit(3000);
                }
                catch
                {
                }
            }
        }

        private static void WriteStep(string target, string message)
        {
            try
            {
                File.AppendAllText(Path.Combine(target, "setup.log"), DateTime.Now.ToString("HH:mm:ss") + " " + message + "\r\n", Encoding.UTF8);
            }
            catch
            {
            }
        }

        private static void TryDeleteDirectory(string path)
        {
            try
            {
                if (Directory.Exists(path)) Directory.Delete(path, true);
            }
            catch
            {
            }
        }

        private static void Log(string message)
        {
            try
            {
                File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + "\r\n", Encoding.UTF8);
            }
            catch
            {
            }
        }
    }
}