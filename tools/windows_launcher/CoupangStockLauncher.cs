using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
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
            Application.Run(new MainForm());
        }
    }

    public class MainForm : Form
    {
        readonly string appDir;
        readonly string dataPath;
        readonly string profileDir;
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly List<ProductRow> products = new List<ProductRow>();

        Process helperProcess;
        int helperPort = 18765;
        int helperDebugPort = 19333;
        DataGridView grid;
        TextBox nameInput;
        TextBox urlInput;
        TextBox logBox;
        Label helperStatus;
        Label summaryLabel;
        Button fetchAllButton;
        Button fetchSelectedButton;
        Button stopButton;
        System.Windows.Forms.Timer healthTimer;
        bool stopping;
        bool fetchRunning;

        public MainForm()
        {
            appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            dataPath = Path.Combine(appDir, "coupang_products.tsv");
            profileDir = Path.Combine(Path.GetTempPath(), "CoupangStockLookupChrome-" + Process.GetCurrentProcess().Id);
            BuildUi();
            LoadProducts();
            StartHealthTimer();
            Log("Coupang stock lookup ready.");
        }

        void BuildUi()
        {
            Text = "Coupang Stock Lookup";
            Width = 1080;
            Height = 680;
            MinimumSize = new Size(900, 560);
            StartPosition = FormStartPosition.CenterScreen;

            var root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.RowCount = 5;
            root.ColumnCount = 1;
            root.Padding = new Padding(12);
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 130));
            Controls.Add(root);

            var title = new Label();
            title.Text = "Coupang Stock Lookup";
            title.Font = new Font(Font.FontFamily, 16, FontStyle.Bold);
            title.AutoSize = true;
            root.Controls.Add(title, 0, 0);

            var addPanel = new TableLayoutPanel();
            addPanel.Dock = DockStyle.Top;
            addPanel.ColumnCount = 5;
            addPanel.RowCount = 2;
            addPanel.Padding = new Padding(0, 10, 0, 8);
            addPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 180));
            addPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            addPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 86));
            addPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 96));
            addPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 116));

            nameInput = new TextBox();
            nameInput.Dock = DockStyle.Fill;
            urlInput = new TextBox();
            urlInput.Dock = DockStyle.Fill;
            addPanel.Controls.Add(nameInput, 0, 0);
            addPanel.Controls.Add(urlInput, 1, 0);
            addPanel.Controls.Add(MakeButton("Add", AddProduct), 2, 0);
            addPanel.Controls.Add(MakeButton("Delete", DeleteSelected), 3, 0);
            addPanel.Controls.Add(MakeButton("Save", SaveProducts), 4, 0);

            helperStatus = new Label();
            helperStatus.Text = "Helper: stopped";
            helperStatus.AutoSize = true;
            helperStatus.Padding = new Padding(0, 8, 16, 0);
            summaryLabel = new Label();
            summaryLabel.Text = "0 products";
            summaryLabel.AutoSize = true;
            summaryLabel.Padding = new Padding(0, 8, 0, 0);
            var statusPanel = new FlowLayoutPanel();
            statusPanel.Dock = DockStyle.Fill;
            statusPanel.Controls.Add(helperStatus);
            statusPanel.Controls.Add(summaryLabel);
            addPanel.SetColumnSpan(statusPanel, 2);
            addPanel.Controls.Add(statusPanel, 0, 1);

            fetchAllButton = MakeButton("Fetch all", FetchAll);
            fetchSelectedButton = MakeButton("Fetch selected", FetchSelected);
            stopButton = MakeButton("Stop helper", StopHelper);
            addPanel.Controls.Add(fetchAllButton, 2, 1);
            addPanel.Controls.Add(fetchSelectedButton, 3, 1);
            addPanel.Controls.Add(stopButton, 4, 1);
            root.Controls.Add(addPanel, 0, 1);

            grid = new DataGridView();
            grid.Dock = DockStyle.Fill;
            grid.AllowUserToAddRows = false;
            grid.AllowUserToDeleteRows = false;
            grid.MultiSelect = true;
            grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
            grid.AutoGenerateColumns = false;
            grid.RowHeadersVisible = false;
            grid.Columns.Add(MakeTextColumn("Name", "Name", 180));
            grid.Columns.Add(MakeTextColumn("Url", "Url", 420));
            grid.Columns.Add(MakeTextColumn("Stock", "Stock", 90));
            grid.Columns.Add(MakeTextColumn("Status", "Status", 190));
            grid.Columns.Add(MakeTextColumn("Elapsed", "Elapsed", 80));
            grid.Columns.Add(MakeTextColumn("UpdatedAt", "Updated", 130));
            grid.CellEndEdit += (sender, args) => SaveProducts();
            root.Controls.Add(grid, 0, 2);

            var hint = new Label();
            hint.Text = "Tip: paste one Coupang product per row. The app stores the list locally next to the EXE and does not use the Naver dashboard.";
            hint.ForeColor = Color.DimGray;
            hint.AutoSize = true;
            hint.Padding = new Padding(0, 8, 0, 8);
            root.Controls.Add(hint, 0, 3);

            logBox = new TextBox();
            logBox.Dock = DockStyle.Fill;
            logBox.Multiline = true;
            logBox.ScrollBars = ScrollBars.Vertical;
            logBox.ReadOnly = true;
            logBox.Font = new Font("Consolas", 9);
            root.Controls.Add(logBox, 0, 4);

            FormClosing += (sender, args) => StopHelper();
        }

        DataGridViewTextBoxColumn MakeTextColumn(string name, string property, int width)
        {
            return new DataGridViewTextBoxColumn
            {
                Name = name,
                HeaderText = name,
                DataPropertyName = property,
                Width = width,
                AutoSizeMode = name == "Url" ? DataGridViewAutoSizeColumnMode.Fill : DataGridViewAutoSizeColumnMode.None
            };
        }

        Button MakeButton(string text, Action action)
        {
            var button = new Button();
            button.Text = text;
            button.Dock = DockStyle.Fill;
            button.Margin = new Padding(6, 0, 0, 6);
            button.Click += (sender, args) => action();
            return button;
        }

        void AddProduct()
        {
            var url = (urlInput.Text ?? "").Trim();
            if (url.Length == 0)
            {
                MessageBox.Show("Paste a Coupang product URL first.", "Coupang Stock Lookup", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            products.Add(new ProductRow
            {
                Name = (nameInput.Text ?? "").Trim(),
                Url = url,
                Stock = "",
                Status = "ready",
                Elapsed = "",
                UpdatedAt = ""
            });
            nameInput.Text = "";
            urlInput.Text = "";
            SaveProducts();
            RefreshGrid();
        }

        void DeleteSelected()
        {
            var indexes = new List<int>();
            foreach (DataGridViewRow row in grid.SelectedRows)
            {
                if (row.Index >= 0 && row.Index < products.Count) indexes.Add(row.Index);
            }
            indexes.Sort();
            indexes.Reverse();
            foreach (var index in indexes) products.RemoveAt(index);
            SaveProducts();
            RefreshGrid();
        }

        void LoadProducts()
        {
            products.Clear();
            if (File.Exists(dataPath))
            {
                foreach (var line in File.ReadAllLines(dataPath, Encoding.UTF8))
                {
                    if (String.IsNullOrWhiteSpace(line)) continue;
                    var parts = line.Split('\t');
                    products.Add(new ProductRow
                    {
                        Name = Unescape(parts, 0),
                        Url = Unescape(parts, 1),
                        Stock = Unescape(parts, 2),
                        Status = Unescape(parts, 3),
                        Elapsed = Unescape(parts, 4),
                        UpdatedAt = Unescape(parts, 5)
                    });
                }
            }
            RefreshGrid();
        }

        void SaveProducts()
        {
            try
            {
                var lines = new List<string>();
                foreach (var item in products)
                {
                    lines.Add(String.Join("\t", new string[] {
                        Escape(item.Name),
                        Escape(item.Url),
                        Escape(item.Stock),
                        Escape(item.Status),
                        Escape(item.Elapsed),
                        Escape(item.UpdatedAt)
                    }));
                }
                File.WriteAllLines(dataPath, lines.ToArray(), Encoding.UTF8);
                summaryLabel.Text = products.Count + " products";
            }
            catch (Exception ex)
            {
                Log("Save failed: " + ex.Message);
            }
        }

        string Escape(string value)
        {
            return (value ?? "").Replace("\\", "\\\\").Replace("\t", "\\t").Replace("\r", "\\r").Replace("\n", "\\n");
        }

        string Unescape(string[] parts, int index)
        {
            if (index >= parts.Length) return "";
            return parts[index].Replace("\\n", "\n").Replace("\\r", "\r").Replace("\\t", "\t").Replace("\\\\", "\\");
        }

        void RefreshGrid()
        {
            grid.DataSource = null;
            grid.DataSource = products;
            summaryLabel.Text = products.Count + " products";
        }

        void StartHealthTimer()
        {
            healthTimer = new System.Windows.Forms.Timer();
            healthTimer.Interval = 3000;
            healthTimer.Tick += (sender, args) => RefreshHealth();
            healthTimer.Start();
            RefreshHealth();
        }

        void FetchAll()
        {
            var indexes = new List<int>();
            for (int i = 0; i < products.Count; i++) indexes.Add(i);
            StartFetch(indexes);
        }

        void FetchSelected()
        {
            var indexes = new List<int>();
            foreach (DataGridViewRow row in grid.SelectedRows)
            {
                if (row.Index >= 0 && row.Index < products.Count) indexes.Add(row.Index);
            }
            indexes.Sort();
            StartFetch(indexes);
        }

        void StartFetch(List<int> indexes)
        {
            if (fetchRunning) return;
            if (indexes.Count == 0)
            {
                MessageBox.Show("No products selected.", "Coupang Stock Lookup", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            fetchRunning = true;
            fetchAllButton.Enabled = false;
            fetchSelectedButton.Enabled = false;
            Task.Run(() => FetchLoop(indexes));
        }

        void FetchLoop(List<int> indexes)
        {
            try
            {
                stopping = false;
                RestartHelperForFetch();
                Thread.Sleep(1200);
                for (int pos = 0; pos < indexes.Count; pos++)
                {
                    var index = indexes[pos];
                    if (index < 0 || index >= products.Count) continue;
                    var product = products[index];
                    UpdateProduct(index, "", "fetching " + (pos + 1) + "/" + indexes.Count, "", "");
                    Log("Fetching: " + DisplayName(product));
                    try
                    {
                        var result = PostJson(HelperUrl() + "/stock", new Dictionary<string, object> {
                            { "productUrl", product.Url },
                            { "fastStockOnly", false }
                        }, 180000);
                        ApplyResult(index, result);
                    }
                    catch (Exception ex)
                    {
                        UpdateProduct(index, "", "failed: " + ex.Message, "", DateTime.Now.ToString("yyyy-MM-dd HH:mm"));
                        Log("Failed: " + DisplayName(product) + " - " + ex.Message);
                    }
                    BeginInvoke(new Action(SaveProducts));
                }
            }
            finally
            {
                BeginInvoke(new Action(() =>
                {
                    fetchRunning = false;
                    fetchAllButton.Enabled = true;
                    fetchSelectedButton.Enabled = true;
                    RefreshGrid();
                }));
            }
        }

        void ApplyResult(int index, Dictionary<string, object> result)
        {
            var ok = result.ContainsKey("ok") && Convert.ToBoolean(result["ok"]);
            if (!ok)
            {
                var error = result.ContainsKey("error") ? Convert.ToString(result["error"]) : "unknown error";
                UpdateProduct(index, "", "failed: " + error, "", DateTime.Now.ToString("yyyy-MM-dd HH:mm"));
                return;
            }
            var stock = result.ContainsKey("stock") && result["stock"] != null ? Convert.ToString(result["stock"]) : "5000+";
            var elapsed = result.ContainsKey("elapsedMs") ? (Convert.ToInt32(result["elapsedMs"]) / 1000.0).ToString("0.0") + "s" : "";
            var apiCalls = result.ContainsKey("apiCalls") ? Convert.ToString(result["apiCalls"]) : "";
            var status = result.ContainsKey("overLimit") && Convert.ToBoolean(result["overLimit"]) ? "over limit" : "ok";
            if (apiCalls.Length > 0) status += " (" + apiCalls + " calls)";
            UpdateProduct(index, stock, status, elapsed, DateTime.Now.ToString("yyyy-MM-dd HH:mm"));
            Log("Done: " + DisplayName(products[index]) + " stock=" + stock);
        }

        void UpdateProduct(int index, string stock, string status, string elapsed, string updatedAt)
        {
            BeginInvoke(new Action(() =>
            {
                if (index < 0 || index >= products.Count) return;
                if (stock.Length > 0) products[index].Stock = stock;
                products[index].Status = status;
                if (elapsed.Length > 0) products[index].Elapsed = elapsed;
                if (updatedAt.Length > 0) products[index].UpdatedAt = updatedAt;
                RefreshGrid();
            }));
        }

        Dictionary<string, object> PostJson(string url, Dictionary<string, object> payload, int timeoutMs)
        {
            var body = json.Serialize(payload);
            var bytes = Encoding.UTF8.GetBytes(body);
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.ContentLength = bytes.Length;
            using (var stream = req.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            try
            {
                using (var response = (HttpWebResponse)req.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    var text = reader.ReadToEnd();
                    return json.Deserialize<Dictionary<string, object>>(text);
                }
            }
            catch (WebException ex)
            {
                var errorBody = ReadWebExceptionBody(ex);
                if (errorBody.Length > 0)
                {
                    try
                    {
                        var parsed = json.Deserialize<Dictionary<string, object>>(errorBody);
                        if (parsed.ContainsKey("error")) throw new Exception(Convert.ToString(parsed["error"]));
                    }
                    catch (Exception inner)
                    {
                        if (!(inner is ArgumentException)) throw;
                    }
                    throw new Exception(errorBody);
                }
                throw;
            }
        }

        string ReadWebExceptionBody(WebException ex)
        {
            try
            {
                if (ex.Response == null) return "";
                using (var reader = new StreamReader(ex.Response.GetResponseStream(), Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch
            {
                return "";
            }
        }

        void RestartHelperForFetch()
        {
            TryHttpPost(HelperUrl() + "/shutdown", 900);
            if (IsProcessAlive(helperProcess))
            {
                try { helperProcess.Kill(); helperProcess.WaitForExit(2000); }
                catch {}
            }
            helperProcess = null;
            Thread.Sleep(900);
            helperPort = FindFreePort(18765);
            helperDebugPort = FindFreePort(19333);
            StartHelper();
        }

        void StartHelper()
        {
            if (IsProcessAlive(helperProcess)) return;
            var node = FindOnPath("node.exe");
            if (node == null) throw new Exception("Node.js was not found.");
            var helper = Path.Combine(appDir, "tools\\coupang_stock_helper.js");
            if (!File.Exists(helper)) throw new Exception("Helper script not found: " + helper);

            var psi = new ProcessStartInfo();
            psi.FileName = node;
            psi.Arguments = "tools\\coupang_stock_helper.js";
            psi.WorkingDirectory = appDir;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            psi.EnvironmentVariables["COUPANG_STOCK_HELPER_PORT"] = helperPort.ToString();
            psi.EnvironmentVariables["COUPANG_STOCK_DEBUG_PORT"] = helperDebugPort.ToString();
            psi.EnvironmentVariables["COUPANG_STOCK_PROFILE_DIR"] = profileDir;
            psi.EnvironmentVariables["COUPANG_STOCK_AUTO_CLOSE_CHROME"] = "0";

            helperProcess = new Process();
            helperProcess.StartInfo = psi;
            helperProcess.EnableRaisingEvents = true;
            helperProcess.OutputDataReceived += (sender, args) => { if (args.Data != null) Log("[helper] " + args.Data); };
            helperProcess.ErrorDataReceived += (sender, args) => { if (args.Data != null) Log("[helper] " + args.Data); };
            helperProcess.Exited += (sender, args) => Log("Helper exited.");
            helperProcess.Start();
            helperProcess.BeginOutputReadLine();
            helperProcess.BeginErrorReadLine();
            Log("Helper started. PID " + helperProcess.Id + ", port " + helperPort + ", debug port " + helperDebugPort);
            BeginInvoke(new Action(RefreshHealth));
        }

        int FindFreePort(int preferred)
        {
            for (int port = preferred; port < preferred + 80; port++)
            {
                try
                {
                    var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, port);
                    listener.Start();
                    listener.Stop();
                    return port;
                }
                catch {}
            }
            return preferred;
        }

        void StopHelper()
        {
            stopping = true;
            TryHttpPost(HelperUrl() + "/shutdown", 900);
            if (IsProcessAlive(helperProcess))
            {
                try { helperProcess.Kill(); helperProcess.WaitForExit(2000); }
                catch {}
            }
            helperProcess = null;
            RefreshHealth();
        }

        void RefreshHealth()
        {
            helperStatus.Text = "Helper: " + (HttpOk(HelperUrl() + "/health", 700) ? "running" : IsProcessAlive(helperProcess) ? "starting" : "stopped") + " :" + helperPort;
        }

        string HelperUrl()
        {
            return "http://127.0.0.1:" + helperPort;
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
            catch {}
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
                catch {}
            }
            return null;
        }

        string DisplayName(ProductRow product)
        {
            return String.IsNullOrWhiteSpace(product.Name) ? product.Url : product.Name;
        }

        void Log(string message)
        {
            if (logBox == null) return;
            if (InvokeRequired)
            {
                BeginInvoke(new Action<string>(Log), message);
                return;
            }
            logBox.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message + Environment.NewLine);
        }
    }

    public class ProductRow
    {
        public string Name { get; set; }
        public string Url { get; set; }
        public string Stock { get; set; }
        public string Status { get; set; }
        public string Elapsed { get; set; }
        public string UpdatedAt { get; set; }
    }
}
