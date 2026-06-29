using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace CoupangStockLauncher
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm());
        }
    }

    public class LauncherForm : Form
    {
        const string DashboardUrl = "https://naver-monitor-production.up.railway.app/?market=coupang_stock";
        const string HelperUrl = "http://127.0.0.1:8765";

        readonly string appDir;
        Process helperProcess;
        Button startButton;
        Button stopButton;
        Button restartHelperButton;
        Button openDashboardButton;
        Button openExtensionButton;
        CheckBox autoRestartHelper;
        Label helperStatus;
        TextBox logBox;
        System.Windows.Forms.Timer healthTimer;
        bool stopping;

        public LauncherForm()
        {
            appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            BuildUi();
            StartHealthTimer();
            Log("Coupang stock lookup launcher ready.");
            Log("App folder: " + appDir);
        }

        void BuildUi()
        {
            Text = "Coupang Stock Lookup";
            Width = 760;
            Height = 500;
            MinimumSize = new Size(680, 420);
            StartPosition = FormStartPosition.CenterScreen;

            var root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.RowCount = 5;
            root.ColumnCount = 1;
            root.Padding = new Padding(12);
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            Controls.Add(root);

            var title = new Label();
            title.Text = "Coupang stock lookup";
            title.Font = new Font(Font.FontFamily, 14, FontStyle.Bold);
            title.AutoSize = true;
            root.Controls.Add(title, 0, 0);

            var subtitle = new Label();
            subtitle.Text = "Starts the local Coupang helper, then opens the stock lookup tab.";
            subtitle.AutoSize = true;
            subtitle.ForeColor = Color.DimGray;
            subtitle.Padding = new Padding(0, 4, 0, 8);
            root.Controls.Add(subtitle, 0, 1);

            var statusPanel = new FlowLayoutPanel();
            statusPanel.AutoSize = true;
            statusPanel.Dock = DockStyle.Top;
            statusPanel.Padding = new Padding(0, 4, 0, 6);
            helperStatus = new Label { Text = "Coupang helper: stopped", AutoSize = true, Width = 240 };
            autoRestartHelper = new CheckBox { Text = "Auto restart helper", Checked = true, AutoSize = true };
            statusPanel.Controls.Add(helperStatus);
            statusPanel.Controls.Add(autoRestartHelper);
            root.Controls.Add(statusPanel, 0, 2);

            var buttons = new FlowLayoutPanel();
            buttons.AutoSize = true;
            buttons.Dock = DockStyle.Top;
            buttons.Padding = new Padding(0, 0, 0, 8);
            startButton = MakeButton("Start and open", StartAll);
            stopButton = MakeButton("Stop", StopAll);
            restartHelperButton = MakeButton("Restart helper", RestartHelper);
            openDashboardButton = MakeButton("Open stock tab", OpenDashboard);
            openExtensionButton = MakeButton("Open extension folder", OpenExtensionFolder);
            buttons.Controls.Add(startButton);
            buttons.Controls.Add(stopButton);
            buttons.Controls.Add(restartHelperButton);
            buttons.Controls.Add(openDashboardButton);
            buttons.Controls.Add(openExtensionButton);
            root.Controls.Add(buttons, 0, 3);

            logBox = new TextBox();
            logBox.Dock = DockStyle.Fill;
            logBox.Multiline = true;
            logBox.ScrollBars = ScrollBars.Vertical;
            logBox.ReadOnly = true;
            logBox.Font = new Font("Consolas", 9);
            root.Controls.Add(logBox, 0, 4);

            FormClosing += (sender, args) => StopAll();
        }

        Button MakeButton(string text, Action action)
        {
            var button = new Button();
            button.Text = text;
            button.AutoSize = true;
            button.Margin = new Padding(0, 0, 8, 0);
            button.Click += (sender, args) => action();
            return button;
        }

        void StartHealthTimer()
        {
            healthTimer = new System.Windows.Forms.Timer();
            healthTimer.Interval = 5000;
            healthTimer.Tick += (sender, args) => RefreshHealth();
            healthTimer.Start();
            RefreshHealth();
        }

        void StartAll()
        {
            stopping = false;
            StartHelper();
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Thread.Sleep(1500);
                BeginInvoke(new Action(OpenDashboard));
            });
        }

        void StopAll()
        {
            stopping = true;
            StopHelper();
            RefreshHealth();
        }

        void RestartHelper()
        {
            stopping = false;
            StopHelper();
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Thread.Sleep(800);
                BeginInvoke(new Action(StartHelper));
            });
        }

        void StartHelper()
        {
            if (IsProcessAlive(helperProcess))
            {
                Log("Coupang helper already running.");
                return;
            }
            var node = FindOnPath("node.exe");
            if (node == null)
            {
                Log("Node.js was not found. Install Node.js, then restart this app.");
                return;
            }
            var helper = Path.Combine(appDir, "tools\\coupang_stock_helper.js");
            if (!File.Exists(helper))
            {
                Log("Coupang helper script not found: " + helper);
                return;
            }
            TryHttpPost(HelperUrl + "/shutdown", 900);
            var psi = new ProcessStartInfo();
            psi.FileName = node;
            psi.Arguments = "tools\\coupang_stock_helper.js";
            psi.WorkingDirectory = appDir;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            helperProcess = StartProcess(psi, "helper");
            helperStatus.Text = "Coupang helper: starting";
        }

        Process StartProcess(ProcessStartInfo psi, string name)
        {
            var process = new Process();
            process.StartInfo = psi;
            process.EnableRaisingEvents = true;
            process.OutputDataReceived += (sender, args) => { if (args.Data != null) Log("[" + name + "] " + args.Data); };
            process.ErrorDataReceived += (sender, args) => { if (args.Data != null) Log("[" + name + "] " + args.Data); };
            process.Exited += (sender, args) =>
            {
                Log(name + " exited.");
                if (name == "helper" && !stopping && autoRestartHelper.Checked)
                {
                    Log("Restarting Coupang helper...");
                    ThreadPool.QueueUserWorkItem(_ =>
                    {
                        Thread.Sleep(1500);
                        BeginInvoke(new Action(StartHelper));
                    });
                }
            };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            Log(name + " started. PID " + process.Id);
            return process;
        }

        void StopHelper()
        {
            TryHttpPost(HelperUrl + "/shutdown", 900);
            if (IsProcessAlive(helperProcess)) TryKill(helperProcess, "helper");
            helperProcess = null;
        }

        void TryKill(Process process, string name)
        {
            try
            {
                process.Kill();
                process.WaitForExit(2500);
                Log(name + " stopped.");
            }
            catch (Exception ex)
            {
                Log("Failed to stop " + name + ": " + ex.Message);
            }
        }

        void OpenDashboard()
        {
            try
            {
                Process.Start(new ProcessStartInfo(DashboardUrl) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Log("Failed to open stock tab: " + ex.Message);
            }
        }

        void OpenExtensionFolder()
        {
            var folder = Path.Combine(appDir, "chrome_extension");
            if (!Directory.Exists(folder))
            {
                Log("Extension folder not found: " + folder);
                return;
            }
            Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true });
        }

        void RefreshHealth()
        {
            helperStatus.Text = "Coupang helper: " + (HttpOk(HelperUrl + "/health", 900) ? "running" : IsProcessAlive(helperProcess) ? "starting" : "stopped");
        }

        bool HttpOk(string url, int timeoutMs)
        {
            try
            {
                var request = WebRequest.Create(url);
                request.Timeout = timeoutMs;
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    return (int)response.StatusCode >= 200 && (int)response.StatusCode < 500;
                }
            }
            catch
            {
                return false;
            }
        }

        void TryHttpPost(string url, int timeoutMs)
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "POST";
                request.Timeout = timeoutMs;
                request.ContentLength = 0;
                using (request.GetResponse()) { }
            }
            catch
            {
            }
        }

        bool IsProcessAlive(Process process)
        {
            try { return process != null && !process.HasExited; }
            catch { return false; }
        }

        string FindOnPath(string file)
        {
            var paths = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator);
            foreach (var dir in paths)
            {
                try
                {
                    var full = Path.Combine(dir.Trim(), file);
                    if (File.Exists(full)) return full;
                }
                catch
                {
                }
            }
            return null;
        }

        void Log(string message)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action<string>(Log), message);
                return;
            }
            logBox.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message + Environment.NewLine);
        }
    }
}
