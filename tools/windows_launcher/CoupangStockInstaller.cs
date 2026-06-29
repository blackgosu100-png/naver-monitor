using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace CoupangStockInstaller
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            try
            {
                var installDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "CoupangStockLookup"
                );
                Directory.CreateDirectory(installDir);

                var tempZip = Path.Combine(Path.GetTempPath(), "coupang-stock-app.zip");
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("coupang-stock-app.zip"))
                {
                    if (stream == null) throw new Exception("Embedded app package was not found.");
                    using (var file = File.Create(tempZip))
                    {
                        stream.CopyTo(file);
                    }
                }

                RunPowerShell(
                    "Expand-Archive -LiteralPath " + QuotePs(tempZip) +
                    " -DestinationPath " + QuotePs(installDir) + " -Force"
                );

                var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                var shortcut = Path.Combine(desktop, "Coupang Stock Lookup.lnk");
                var launcher = Path.Combine(installDir, "CoupangStockLauncher.exe");
                RunPowerShell(
                    "$ws=New-Object -ComObject WScript.Shell; " +
                    "$s=$ws.CreateShortcut(" + QuotePs(shortcut) + "); " +
                    "$s.TargetPath=" + QuotePs(launcher) + "; " +
                    "$s.WorkingDirectory=" + QuotePs(installDir) + "; " +
                    "$s.Save()"
                );

                Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true });
                MessageBox.Show(
                    "Coupang Stock Lookup was installed.\n\nA desktop shortcut was created.",
                    "Coupang Stock Lookup Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Installation failed:\n\n" + ex.Message,
                    "Coupang Stock Lookup Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                Environment.ExitCode = 1;
            }
        }

        static string QuotePs(string value)
        {
            return "'" + value.Replace("'", "''") + "'";
        }

        static void RunPowerShell(string command)
        {
            var psi = new ProcessStartInfo();
            psi.FileName = "powershell.exe";
            psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command " + QuoteArgument(command);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            using (var process = Process.Start(psi))
            {
                var output = process.StandardOutput.ReadToEnd();
                var error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                if (process.ExitCode != 0)
                {
                    throw new Exception(error.Length > 0 ? error : output);
                }
            }
        }

        static string QuoteArgument(string value)
        {
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }
    }
}
