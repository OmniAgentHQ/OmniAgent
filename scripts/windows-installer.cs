// OmniAgent Core installer for Windows.
//
//   OmniAgent-Win64.exe                 One Install button, then a progress bar
//   OmniAgent-Win64.exe --silent        Install with no window
//   OmniAgent-Win64.exe --no-engines    Skip the engines, the app can download them later
//   OmniAgent-Win64.exe --uninstall     Remove the app
//
// Everything goes in the user's own folders, so it never asks for admin rights. The app is packed onto
// the end of this exe, and the engines are downloaded from the companies that make them, so people
// always start on the latest versions however old the installer is. Core gets ChatGPT and Claude.
//
// This compiles with the C# 5 compiler that ships with Windows, which is why it avoids newer syntax.
// package-core-windows.mjs fills in the version, compiles this and appends the app.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

[assembly: AssemblyTitle(OmniAgent.Installer.Product.Name + " Installer")]
[assembly: AssemblyDescription(OmniAgent.Installer.Product.Name + " Installer")]
[assembly: AssemblyProduct(OmniAgent.Installer.Product.Name)]
[assembly: AssemblyCompany("OmniAgent")]
[assembly: AssemblyVersion("@@APP_VERSION@@.0")]
[assembly: AssemblyFileVersion("@@APP_VERSION@@.0")]
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.7.2")]

namespace OmniAgent.Installer
{
    delegate void Report(double fraction, string status);

    // A problem to show the user as it is.
    sealed class Problem : Exception
    {
        public Problem(string message) : base(message) { }
    }

    static class Product
    {
        public const string Name = "OmniAgent Core";
        public const string ModelId = "app.omniagent.core";
        public const string DataFolder = "OmniAgent Core";
        public const string Tagline = "ChatGPT and Claude on the same team.";
        public const string WorkingText = "Getting the app and the latest engines ready.";
        public const string ReadyText = "Open it now, or find it in your Start menu any time.";
        public const string Version = "@@APP_VERSION@@";
        public const string Executable = Name + ".exe";
        public const string Uninstaller = "Uninstall " + Name + ".exe";
        public const string Publisher = "OmniAgent";
        public const string Website = "https://omniagenthq.com";
    }

    static class Paths
    {
        // The environment comes first so a test run can point the whole install at a throwaway folder.
        static string Root(string variable, Environment.SpecialFolder fallback)
        {
            string value = Environment.GetEnvironmentVariable(variable);
            return string.IsNullOrEmpty(value) ? Environment.GetFolderPath(fallback) : value;
        }

        static readonly string Local = Root("LOCALAPPDATA", Environment.SpecialFolder.LocalApplicationData);
        static readonly string Roaming = Root("APPDATA", Environment.SpecialFolder.ApplicationData);

        public static readonly string Programs = Path.Combine(Local, "Programs");
        public static readonly string App = Path.Combine(Programs, Product.Name);
        public static readonly string NewApp = App + ".new";
        public static readonly string OldApp = App + ".old";
        public static readonly string AppExe = Path.Combine(App, Product.Executable);
        public static readonly string Uninstaller = Path.Combine(App, Product.Uninstaller);
        public static readonly string UserData = Path.Combine(Roaming, Product.DataFolder);
        public static readonly string Engines = Path.Combine(UserData, "providers");
        public static readonly string StartMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Product.Name + ".lnk");
        public static readonly string Desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Product.Name + ".lnk");
        public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Product.Name;
        public static readonly string Self = Process.GetCurrentProcess().MainModule.FileName;
    }

    static class Disk
    {
        // Antivirus often holds new files for a moment, so anything that moves or removes them gets a few tries.
        public static void Retry(Action action, int attempts = 20)
        {
            for (int attempt = 1; ; attempt++)
            {
                try
                {
                    action();
                    return;
                }
                catch (Exception error)
                {
                    if (attempt >= attempts || !(error is IOException || error is UnauthorizedAccessException)) throw;
                    Thread.Sleep(250);
                }
            }
        }

        public static void Remove(string folder)
        {
            if (Directory.Exists(folder)) Retry(() => Directory.Delete(folder, true));
        }

        public static void RemoveQuietly(string folder)
        {
            try { Remove(folder); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }

        public static void Require(long bytes)
        {
            long free = new DriveInfo(Path.GetPathRoot(Paths.Programs)).AvailableFreeSpace;
            if (free < bytes) throw new Problem(string.Format("{0} needs about {1:N0} MB free, and this drive has {2:N0} MB.", Product.Name, bytes / 1000000, free / 1000000));
        }
    }

    // The part of this exe after the program itself. The last 48 bytes are the zip's length, its SHA-256 and a marker.
    sealed class Payload
    {
        const string Marker = "OMNIPACK";
        const int FooterBytes = 48;
        const int BufferBytes = 1 << 20;

        readonly long length;
        readonly byte[] checksum;
        public readonly long Start;

        Payload(long start, long length, byte[] checksum)
        {
            Start = start;
            this.length = length;
            this.checksum = checksum;
        }

        public static Payload Find()
        {
            using (var file = new FileStream(Paths.Self, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (file.Length < FooterBytes) return null;
                var footer = new byte[FooterBytes];
                file.Seek(-FooterBytes, SeekOrigin.End);
                if (file.Read(footer, 0, FooterBytes) != FooterBytes) return null;
                if (Encoding.ASCII.GetString(footer, 40, 8) != Marker) return null;
                long size = BitConverter.ToInt64(footer, 0);
                long start = file.Length - FooterBytes - size;
                if (size <= 0 || start <= 0) throw new Problem("This installer is damaged. Download it again.");
                var sum = new byte[32];
                Array.Copy(footer, 8, sum, 0, 32);
                return new Payload(start, size, sum);
            }
        }

        Stream Open()
        {
            return new Slice(new FileStream(Paths.Self, FileMode.Open, FileAccess.Read, FileShare.Read, BufferBytes), Start, length);
        }

        public void Verify(Action<double> progress, CancellationToken stop)
        {
            using (var stream = Open())
            using (var hash = SHA256.Create())
            {
                var buffer = new byte[BufferBytes];
                long seen = 0;
                for (;;)
                {
                    stop.ThrowIfCancellationRequested();
                    int count = stream.Read(buffer, 0, buffer.Length);
                    if (count == 0) break;
                    hash.TransformBlock(buffer, 0, count, null, 0);
                    seen += count;
                    progress((double)seen / length);
                }
                hash.TransformFinalBlock(buffer, 0, 0);
                if (!hash.Hash.SequenceEqual(checksum)) throw new Problem("This installer is damaged. Download it again.");
            }
        }

        public long UnpackedBytes()
        {
            using (var stream = Open())
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                return zip.Entries.Sum(entry => entry.Length);
            }
        }

        public void Unpack(string folder, Action<double> progress, CancellationToken stop)
        {
            string root = Path.GetFullPath(folder) + Path.DirectorySeparatorChar;
            var buffer = new byte[BufferBytes];
            using (var stream = Open())
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                long total = zip.Entries.Sum(entry => entry.Length);
                long written = 0;
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    stop.ThrowIfCancellationRequested();
                    string target = Path.GetFullPath(Path.Combine(folder, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Problem("This installer is damaged. Download it again.");
                    if (entry.FullName.EndsWith("/"))
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream input = entry.Open())
                    using (var output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None, BufferBytes))
                    {
                        int count;
                        while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            stop.ThrowIfCancellationRequested();
                            output.Write(buffer, 0, count);
                            written += count;
                            progress((double)written / total);
                        }
                    }
                }
            }
        }

        public void WriteProgramOnly(string target)
        {
            using (var input = new FileStream(Paths.Self, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var output = new FileStream(target, FileMode.Create, FileAccess.Write))
            {
                var buffer = new byte[BufferBytes];
                long left = Start;
                while (left > 0)
                {
                    int count = input.Read(buffer, 0, (int)Math.Min(left, buffer.Length));
                    if (count == 0) throw new EndOfStreamException();
                    output.Write(buffer, 0, count);
                    left -= count;
                }
            }
        }
    }

    // A read-only window onto part of a file, which is all ZipArchive needs.
    sealed class Slice : Stream
    {
        readonly Stream inner;
        readonly long start;
        readonly long length;
        long position;

        public Slice(Stream inner, long start, long length)
        {
            this.inner = inner;
            this.start = start;
            this.length = length;
            inner.Seek(start, SeekOrigin.Begin);
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }
        public override long Position { get { return position; } set { Seek(value, SeekOrigin.Begin); } }

        public override int Read(byte[] buffer, int offset, int count)
        {
            int wanted = (int)Math.Min(count, length - position);
            if (wanted <= 0) return 0;
            int read = inner.Read(buffer, offset, wanted);
            position += read;
            return read;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long target = origin == SeekOrigin.Begin ? offset : origin == SeekOrigin.Current ? position + offset : length + offset;
            if (target < 0) throw new IOException("Seek before the start of the payload.");
            position = target;
            inner.Seek(start + target, SeekOrigin.Begin);
            return position;
        }

        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }

        protected override void Dispose(bool disposing)
        {
            if (disposing) inner.Dispose();
            base.Dispose(disposing);
        }
    }

    static class Net
    {
        const int Attempts = 4;

        static HttpWebRequest Request(string url)
        {
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.UserAgent = "OmniAgent";
            request.Timeout = 30000;
            request.ReadWriteTimeout = 60000;
            return request;
        }

        public static string Text(string url, CancellationToken stop)
        {
            HttpWebRequest request = Request(url);
            using (stop.Register(request.Abort))
            using (WebResponse response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        // Every attempt starts over, so a dropped connection can't leave half a file that passes as whole.
        public static void Save(string url, string target, string checksum, Action<long, long> progress, CancellationToken stop)
        {
            for (int attempt = 1; ; attempt++)
            {
                try
                {
                    SaveOnce(url, target, checksum, progress, stop);
                    return;
                }
                catch (Exception error)
                {
                    stop.ThrowIfCancellationRequested();
                    if (attempt >= Attempts || !(error is WebException || error is IOException)) throw;
                    Thread.Sleep(1500 * attempt);
                }
            }
        }

        static void SaveOnce(string url, string target, string checksum, Action<long, long> progress, CancellationToken stop)
        {
            HttpWebRequest request = Request(url);
            using (stop.Register(request.Abort))
            using (WebResponse response = request.GetResponse())
            using (Stream input = response.GetResponseStream())
            using (var output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20))
            using (var hash = SHA256.Create())
            {
                long total = response.ContentLength;
                long seen = 0;
                var buffer = new byte[1 << 18];
                int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    stop.ThrowIfCancellationRequested();
                    output.Write(buffer, 0, count);
                    hash.TransformBlock(buffer, 0, count, null, 0);
                    seen += count;
                    progress(seen, total);
                }
                if (total > 0 && seen != total) throw new IOException("The download finished early.");
                hash.TransformFinalBlock(buffer, 0, 0);
                string actual = BitConverter.ToString(hash.Hash).Replace("-", "");
                if (!string.IsNullOrEmpty(checksum) && !actual.Equals(checksum, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("the download failed its checksum check.");
                }
            }
        }
    }

    // These live where the app looks for them, so its welcome screen shows them as ready.
    sealed class EngineSetup
    {
        const string ClaudeReleases = "https://downloads.claude.ai/claude-code-releases";
        const string CodexRelease = "https://api.github.com/repos/openai/codex/releases/latest";
        const string CodexAsset = "codex-package-x86_64-pc-windows-msvc.tar.gz";

        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        readonly Report report;
        readonly CancellationToken stop;
        readonly string staging = Path.Combine(Paths.Engines, ".staging-installer-" + Process.GetCurrentProcess().Id);

        public readonly List<string> Failed = new List<string>();
        public readonly List<string> Details = new List<string>();

        public EngineSetup(Report report, CancellationToken stop)
        {
            this.report = report;
            this.stop = stop;
        }

        sealed class Engine
        {
            public string Name;
            public int Megabytes;
            public Action<double, double> Install;
        }

        // Smallest first where it matters: a stopped install still leaves the engines most people use.
        List<Engine> Engines()
        {
            return new List<Engine>
            {
                new Engine { Name = "ChatGPT", Megabytes = 200, Install = InstallChatGpt },
                new Engine { Name = "Claude", Megabytes = 340, Install = InstallClaude },
            };
        }

        public void Run(double start, double end)
        {
            Directory.CreateDirectory(staging);
            try
            {
                List<Engine> engines = Engines();
                double total = engines.Sum(engine => engine.Megabytes);
                double at = start;
                foreach (Engine engine in engines)
                {
                    Engine current = engine;
                    double from = at;
                    double to = at + (end - start) * current.Megabytes / total;
                    Attempt(current.Name, () => current.Install(from, to));
                    at = to;
                }
            }
            finally
            {
                Disk.RemoveQuietly(staging);
            }
        }

        // A failed engine never fails the install, because the app's welcome screen can fetch it too.
        void Attempt(string name, Action install)
        {
            try
            {
                install();
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception error)
            {
                stop.ThrowIfCancellationRequested();
                Failed.Add(name);
                Details.Add(name + " engine: " + error.Message);
            }
        }

        // The app's own updater keeps newer engines under updates/ and points at them from a small file.
        static string InUse(string id, string standard)
        {
            try
            {
                var pointer = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(Paths.Engines, id + "-active.json")));
                string target = Path.GetFullPath(Path.Combine(Paths.Engines, (string)pointer["path"]));
                if (target.StartsWith(Path.Combine(Paths.Engines, "updates", id) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && File.Exists(target)) return target;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            catch (KeyNotFoundException) { }
            catch (InvalidCastException) { }
            return File.Exists(standard) ? standard : "";
        }

        static string VersionOf(string executable)
        {
            try
            {
                var start = new ProcessStartInfo(executable, "--version") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                using (Process process = Process.Start(start))
                {
                    Task<string> output = process.StandardOutput.ReadToEndAsync();
                    process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(15000))
                    {
                        process.Kill();
                        return "";
                    }
                    return output.Wait(2000) ? Regex.Match(output.Result, @"\d+\.\d+\.\d+").Value : "";
                }
            }
            catch (System.ComponentModel.Win32Exception)
            {
                return "";
            }
        }

        static bool IsCurrent(string executable, string version)
        {
            return executable != "" && version != "" && VersionOf(executable) == version;
        }

        void Activate(string id, string unpacked)
        {
            Disk.Remove(Path.Combine(Paths.Engines, id));
            Disk.Remove(Path.Combine(Paths.Engines, "updates", id));
            File.Delete(Path.Combine(Paths.Engines, id + "-active.json"));
            Disk.Retry(() => Directory.Move(unpacked, Path.Combine(Paths.Engines, id)));
        }

        void Download(string url, string target, string checksum, string label, double start, double end)
        {
            report(start, "Downloading " + label);
            Net.Save(url, target, checksum, (seen, total) =>
            {
                double part = total > 0 ? (double)seen / total : 0;
                string status = total > 0 ? string.Format("Downloading {0}, {1} of {2} MB", label, seen / 1000000, total / 1000000) : "Downloading " + label;
                report(start + (end - start) * part, status);
            }, stop);
        }

        // GitHub limits this lookup per address, and the download still works without it.
        void ReadRelease(string address, string assetName, ref string version, ref string checksum, ref string url)
        {
            try
            {
                var release = Json.Deserialize<Dictionary<string, object>>(Net.Text(address, stop));
                version = Regex.Match(Convert.ToString(release["tag_name"]), @"\d+\.\d+\.\d+").Value;
                foreach (object item in (IEnumerable)release["assets"])
                {
                    var asset = (Dictionary<string, object>)item;
                    if (Convert.ToString(asset["name"]) != assetName) continue;
                    object digest;
                    if (asset.TryGetValue("digest", out digest)) checksum = Convert.ToString(digest).Replace("sha256:", "");
                    url = Convert.ToString(asset["browser_download_url"]);
                }
            }
            catch (Exception error)
            {
                stop.ThrowIfCancellationRequested();
                if (!(error is WebException || error is IOException || error is ArgumentException || error is InvalidOperationException || error is KeyNotFoundException || error is InvalidCastException)) throw;
            }
        }

        void InstallChatGpt(double start, double end)
        {
            report(start, "Finding the latest ChatGPT engine");
            string version = "";
            string checksum = "";
            string url = "https://github.com/openai/codex/releases/latest/download/" + CodexAsset;
            ReadRelease(CodexRelease, CodexAsset, ref version, ref checksum, ref url);

            string standard = Path.Combine(Paths.Engines, "codex", "bin", "codex.exe");
            if (IsCurrent(InUse("codex", standard), version))
            {
                report(end, "ChatGPT engine " + version + " is already the latest");
                return;
            }

            string archive = Path.Combine(staging, CodexAsset);
            string label = "ChatGPT engine" + (version == "" ? "" : " " + version);
            Download(url, archive, checksum, label, start, start + (end - start) * 0.92);

            report(start + (end - start) * 0.94, "Unpacking the ChatGPT engine");
            string unpacked = Path.Combine(staging, "codex");
            Directory.CreateDirectory(unpacked);
            Untar(archive, unpacked);
            if (!File.Exists(Path.Combine(unpacked, "bin", "codex.exe"))) throw new InvalidDataException("the download could not be unpacked.");
            File.Delete(archive);
            Activate("codex", unpacked);
            report(end, label + " is ready");
        }

        void InstallClaude(double start, double end)
        {
            report(start, "Finding the latest Claude engine");
            string version = Net.Text(ClaudeReleases + "/latest", stop).Trim();
            if (!Regex.IsMatch(version, @"^\d+\.\d+\.\d+")) throw new InvalidDataException("couldn't find the latest version.");
            var manifest = Json.Deserialize<Dictionary<string, object>>(Net.Text(ClaudeReleases + "/" + version + "/manifest.json", stop));
            var platforms = (Dictionary<string, object>)manifest["platforms"];
            string checksum = Convert.ToString(((Dictionary<string, object>)platforms["win32-x64"])["checksum"]);
            if (!Regex.IsMatch(checksum, "^[0-9a-fA-F]{64}$")) throw new InvalidDataException("couldn't verify the latest version.");

            string standard = Path.Combine(Paths.Engines, "claude", "claude.exe");
            if (IsCurrent(InUse("claude", standard), version))
            {
                report(end, "Claude engine " + version + " is already the latest");
                return;
            }

            string unpacked = Path.Combine(staging, "claude");
            Directory.CreateDirectory(unpacked);
            string label = "Claude engine " + version;
            Download(ClaudeReleases + "/" + version + "/win32-x64/claude.exe", Path.Combine(unpacked, "claude.exe"), checksum, label, start, end - (end - start) * 0.02);
            Activate("claude", unpacked);
            report(end, label + " is ready");
        }


        void Untar(string archive, string folder)
        {
            string tar = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "tar.exe");
            var start = new ProcessStartInfo(tar, "-xf \"" + archive + "\" -C \"" + folder + "\"") { UseShellExecute = false, CreateNoWindow = true };
            using (Process process = Process.Start(start))
            {
                while (!process.WaitForExit(200))
                {
                    if (!stop.IsCancellationRequested) continue;
                    process.Kill();
                    stop.ThrowIfCancellationRequested();
                }
                if (process.ExitCode != 0) throw new InvalidDataException("the download could not be unpacked.");
            }
        }
    }

    static class Setup
    {
        // The bar's share for each stage. Engines take the most time because they're the only downloads.
        const long EnginesBytes = 1200000000;
        const double Verified = 0.03;
        const double Unpacked = 0.30;
        const double Registered = 0.33;

        // A local model server left running would hold its files open.
        static void StopLocalModels()
        {
        }

        static bool AppIsOpen()
        {
            return Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Product.Executable)).Length > 0;
        }

        public static EngineSetup Install(Payload payload, bool withEngines, Report report, CancellationToken stop)
        {
            if (AppIsOpen()) throw new Problem(Product.Name + " is open. Close it and try again.");
            StopLocalModels();

            report(0, "Checking the installer");
            payload.Verify(part => report(part * Verified, "Checking the installer"), stop);
            long appBytes = payload.UnpackedBytes();
            Disk.Require(appBytes + (withEngines ? EnginesBytes : 0));

            Directory.CreateDirectory(Paths.Programs);
            Disk.Remove(Paths.NewApp);
            try
            {
                string status = "Installing " + Product.Name + " " + Product.Version;
                report(Verified, status);
                payload.Unpack(Paths.NewApp, part => report(Verified + part * (Unpacked - Verified), status), stop);
                Replace();
            }
            finally
            {
                Disk.RemoveQuietly(Paths.NewApp);
            }

            report(Unpacked, "Adding it to your Start menu");
            payload.WriteProgramOnly(Paths.Uninstaller);
            Shortcut.Create(Paths.StartMenu);
            Shortcut.Create(Paths.Desktop);
            Register(appBytes);
            Shortcut.RefreshIcons();
            report(Registered, "Adding it to your Start menu");

            var engines = new EngineSetup(report, stop);
            if (withEngines) engines.Run(Registered, 1);
            report(1, Product.Name + " is ready");
            return engines;
        }

        // The old app stays whole until the new one is fully unpacked, so a failed update changes nothing.
        static void Replace()
        {
            Disk.Remove(Paths.OldApp);
            if (Directory.Exists(Paths.App)) Disk.Retry(() => Directory.Move(Paths.App, Paths.OldApp));
            try
            {
                Disk.Retry(() => Directory.Move(Paths.NewApp, Paths.App));
            }
            catch (Exception)
            {
                if (Directory.Exists(Paths.OldApp)) Disk.Retry(() => Directory.Move(Paths.OldApp, Paths.App));
                throw;
            }
            Disk.RemoveQuietly(Paths.OldApp);
        }

        // This is the entry Settings shows under Installed apps.
        static void Register(long appBytes)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(Paths.UninstallKey))
            {
                key.SetValue("DisplayName", Product.Name);
                key.SetValue("DisplayVersion", Product.Version);
                key.SetValue("Publisher", Product.Publisher);
                key.SetValue("URLInfoAbout", Product.Website);
                key.SetValue("DisplayIcon", Paths.AppExe + ",0");
                key.SetValue("InstallLocation", Paths.App);
                key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                key.SetValue("UninstallString", "\"" + Paths.Uninstaller + "\" --uninstall");
                key.SetValue("QuietUninstallString", "\"" + Paths.Uninstaller + "\" --uninstall --silent");
                key.SetValue("EstimatedSize", (int)(appBytes / 1024), RegistryValueKind.DWord);
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        public static void Uninstall(bool deleteUserData, Report report)
        {
            if (AppIsOpen()) throw new Problem(Product.Name + " is open. Close it and try again.");
            StopLocalModels();

            report(0.1, "Removing shortcuts");
            File.Delete(Paths.StartMenu);
            File.Delete(Paths.Desktop);
            Registry.CurrentUser.DeleteSubKeyTree(Paths.UninstallKey, false);

            report(0.3, "Removing the engines");
            Disk.RemoveQuietly(Paths.Engines);

            if (deleteUserData)
            {
                report(0.5, "Removing your settings and chats");
                Disk.Remove(Paths.UserData);
            }

            report(0.7, "Removing the app");
            Disk.Remove(Paths.App);
            Disk.RemoveQuietly(Paths.NewApp);
            Disk.RemoveQuietly(Paths.OldApp);
            Shortcut.RefreshIcons();
            report(1, Product.Name + " is uninstalled");
        }
    }

    // A shortcut needs the app's model ID or Windows treats a pinned app and its window as two apps.
    static class Shortcut
    {
        const ushort StringVariant = 31;

        [DllImport("shell32.dll")]
        static extern void SHChangeNotify(int eventId, uint flags, IntPtr first, IntPtr second);

        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        class ShellLink { }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
        interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int size, IntPtr data, uint flags);
            void GetIDList(out IntPtr list);
            void SetIDList(IntPtr list);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int size);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder folder, int size);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string folder);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int size);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string text);
            void GetHotkey(out short key);
            void SetHotkey(short key);
            void GetShowCmd(out int command);
            void SetShowCmd(int command);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int size, out int index);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string file, int index);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string file, uint reserved);
            void Resolve(IntPtr window, uint flags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
        }

        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        struct PropertyKey
        {
            public Guid Format;
            public uint Id;
        }

        [StructLayout(LayoutKind.Explicit)]
        struct PropertyValue
        {
            [FieldOffset(0)] public ushort Type;
            [FieldOffset(8)] public IntPtr Text;
            [FieldOffset(16)] public IntPtr Unused;
        }

        [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
        interface IPropertyStore
        {
            void GetCount(out uint count);
            void GetAt(uint index, out PropertyKey key);
            void GetValue(ref PropertyKey key, out PropertyValue value);
            void SetValue(ref PropertyKey key, ref PropertyValue value);
            void Commit();
        }

        public static void Create(string file)
        {
            var link = (IShellLinkW)new ShellLink();
            link.SetPath(Paths.AppExe);
            link.SetWorkingDirectory(Paths.App);
            link.SetDescription(Product.Tagline);
            link.SetIconLocation(Paths.AppExe, 0);

            var key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
            var value = new PropertyValue { Type = StringVariant, Text = Marshal.StringToCoTaskMemUni(Product.ModelId) };
            try
            {
                var store = (IPropertyStore)link;
                store.SetValue(ref key, ref value);
                store.Commit();
            }
            finally
            {
                Marshal.FreeCoTaskMem(value.Text);
            }
            ((IPersistFile)link).Save(file, true);
        }

        public static void RefreshIcons()
        {
            SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
        }
    }

    sealed class Screen
    {
        static readonly TimeSpan Motion = TimeSpan.FromMilliseconds(260);

        readonly Options options;
        readonly Window window;
        readonly Grid root;
        readonly Grid track;
        readonly TextBlock heading;
        readonly TextBlock subtitle;
        readonly TextBlock status;
        readonly TextBlock percent;
        readonly Panel choice;
        readonly Panel working;
        readonly CheckBox deleteData;
        readonly Button action;
        readonly Button close;
        readonly FrameworkElement fill;

        CancellationTokenSource stop;
        bool busy;
        Action next;

        static Stream Resource(string name)
        {
            return Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        }

        public Screen(Options options)
        {
            this.options = options;
            using (Stream xaml = Resource("windows-installer.xaml")) window = (Window)XamlReader.Load(xaml);
            window.Title = Product.Name;
            root = (Grid)window.FindName("Root");
            track = (Grid)window.FindName("Track");
            heading = (TextBlock)window.FindName("Heading");
            subtitle = (TextBlock)window.FindName("Subtitle");
            status = (TextBlock)window.FindName("Status");
            percent = (TextBlock)window.FindName("Percent");
            choice = (Panel)window.FindName("Choice");
            working = (Panel)window.FindName("Working");
            deleteData = (CheckBox)window.FindName("DeleteData");
            action = (Button)window.FindName("Action");
            close = (Button)window.FindName("CloseButton");
            fill = (FrameworkElement)window.FindName("Fill");

            var logo = new BitmapImage();
            logo.BeginInit();
            logo.CacheOption = BitmapCacheOption.OnLoad;
            logo.StreamSource = Resource("logo.png");
            logo.EndInit();
            ((Image)window.FindName("Logo")).Source = logo;

            root.MouseLeftButtonDown += (sender, args) => window.DragMove();
            action.Click += (sender, args) => next();
            close.Click += (sender, args) => window.Close();
            window.Closing += (sender, args) =>
            {
                if (!busy) return;
                args.Cancel = true;
                stop.Cancel();
                close.IsEnabled = false;
                status.Text = "Stopping";
            };

            var flow = new TranslateTransform();
            ((System.Windows.Shapes.Rectangle)fill).Fill.Transform = flow;
            flow.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(0, 260, TimeSpan.FromSeconds(1.8)) { RepeatBehavior = RepeatBehavior.Forever });
        }

        public void Show()
        {
            if (options.Uninstall) AskToUninstall();
            else AskToInstall();
            window.Show();
            Reveal(root);
        }

        static void Reveal(UIElement element)
        {
            element.Visibility = Visibility.Visible;
            element.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, Motion));
        }

        void Offer(string title, string detail, string button, Action run)
        {
            busy = false;
            close.IsEnabled = true;
            heading.Text = title;
            subtitle.Text = detail;
            action.Content = button;
            next = run;
            working.Visibility = Visibility.Collapsed;
            Reveal(choice);
        }

        void Begin(string title, string detail, string firstStatus)
        {
            busy = true;
            stop = new CancellationTokenSource();
            heading.Text = title;
            subtitle.Text = detail;
            choice.Visibility = Visibility.Collapsed;
            fill.BeginAnimation(FrameworkElement.WidthProperty, null);
            fill.Width = 10;
            status.Text = firstStatus;
            percent.Text = "0%";
            Reveal(working);
            window.UpdateLayout();
        }

        void Update(double fraction, string text)
        {
            double width = Math.Max(10, track.ActualWidth * Math.Min(1, fraction));
            fill.BeginAnimation(FrameworkElement.WidthProperty, new DoubleAnimation(width, Motion) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } });
            percent.Text = Math.Round(fraction * 100) + "%";
            if (close.IsEnabled) status.Text = text;
        }

        // Unpacking reports for every chunk, far more often than a screen can show.
        Report Throttled()
        {
            var clock = Stopwatch.StartNew();
            long last = -1000;
            string lastText = "";
            return (fraction, text) =>
            {
                long now = clock.ElapsedMilliseconds;
                if (now - last < 80 && text == lastText && fraction < 1) return;
                last = now;
                lastText = text;
                window.Dispatcher.BeginInvoke(new Action(() => Update(fraction, text)));
            };
        }

        void AskToInstall()
        {
            Offer(Product.Name, Product.Tagline, "Install", Install);
        }

        async void Install()
        {
            Begin("Installing " + Product.Name, Product.WorkingText, "Checking the installer");
            Report report = Throttled();
            CancellationToken token = stop.Token;
            try
            {
                EngineSetup engines = await Task.Run(() => Setup.Install(options.Payload, options.Engines, report, token));
                string detail = engines.Failed.Count == 0
                    ? Product.ReadyText
                    : "The " + string.Join(", ", engines.Failed) + (engines.Failed.Count == 1 ? " engine didn't download." : " engines didn't download.") + " The app's welcome screen can get them for you.";
                Offer(Product.Name + " is ready", detail, "Open " + Product.Name, Launch);
            }
            catch (OperationCanceledException)
            {
                Application.Current.Shutdown();
            }
            catch (Exception error)
            {
                Offer("That didn't finish", Explain(error), "Try again", Install);
            }
        }

        void Launch()
        {
            Process.Start(new ProcessStartInfo(Paths.AppExe) { UseShellExecute = true, WorkingDirectory = Paths.App });
            Application.Current.Shutdown();
        }

        void AskToUninstall()
        {
            deleteData.Visibility = Visibility.Visible;
            Offer("Uninstall " + Product.Name, "This removes the app and its engines from this computer.", "Uninstall", Uninstall);
        }

        async void Uninstall()
        {
            bool deleteUserData = deleteData.IsChecked == true;
            Begin("Uninstalling", "This only takes a moment.", "Removing shortcuts");
            Report report = Throttled();
            try
            {
                await Task.Run(() => Setup.Uninstall(deleteUserData, report));
                deleteData.Visibility = Visibility.Collapsed;
                Offer("Uninstalled", Product.Name + " is gone from this computer.", "Close", () => Application.Current.Shutdown());
            }
            catch (Exception error)
            {
                Offer("That didn't finish", Explain(error), "Try again", Uninstall);
            }
        }

        static string Explain(Exception error)
        {
            if (error is Problem) return error.Message;
            if (error is UnauthorizedAccessException || error is IOException) return "A file is in use. Close " + Product.Name + " and try again.";
            return "Something went wrong: " + error.Message;
        }

#if PREVIEW
        // Saves each state as a picture. Only preview builds have this.
        public async void Capture(string folder)
        {
            Func<string, Task> save = async name =>
            {
                await Task.Delay(600);
                var bitmap = new RenderTargetBitmap(1040, 880, 192, 192, PixelFormats.Pbgra32);
                bitmap.Render((Visual)window.Content);
                var encoder = new PngBitmapEncoder();
                encoder.Frames.Add(BitmapFrame.Create(bitmap));
                using (var file = File.Create(Path.Combine(folder, name + ".png"))) encoder.Save(file);
            };
            Action<string, string, double, string> progress = (title, detail, fraction, text) =>
            {
                Begin(title, detail, text);
                busy = false;
                Update(fraction, text);
            };

            AskToInstall();
            window.Show();
            await save("1-install");
            progress("Installing " + Product.Name, Product.WorkingText, 0.71, "Downloading Claude engine 2.1.300, 96 of 214 MB");
            await save("2-working");
            Offer(Product.Name + " is ready", Product.ReadyText, "Open " + Product.Name, Launch);
            await save("3-ready");
            Offer(Product.Name + " is ready", "The Claude engine didn't download. The app's welcome screen can get it for you.", "Open " + Product.Name, Launch);
            await save("4-warning");
            Offer("That didn't finish", Product.Name + " is open. Close it and try again.", "Try again", Install);
            await save("5-error");
            AskToUninstall();
            await save("6-uninstall");
            Application.Current.Shutdown();
        }
#endif
    }

    sealed class Options
    {
        public bool Silent;
        public bool Engines = true;
        public bool Uninstall;
        public bool Relocated;
        public bool DeleteData;
        public string Log = "";
        public string Preview = "";
        public Payload Payload;

        public static Options Read(string[] arguments)
        {
            var options = new Options();
            foreach (string argument in arguments)
            {
                if (argument == "--silent") options.Silent = true;
                else if (argument == "--no-engines") options.Engines = false;
                else if (argument == "--uninstall") options.Uninstall = true;
                else if (argument == "--relocated") options.Relocated = true;
                else if (argument == "--delete-data") options.DeleteData = true;
                else if (argument.StartsWith("--log=")) options.Log = argument.Substring(6);
                else if (argument.StartsWith("--preview=")) options.Preview = argument.Substring(10);
            }
            options.Payload = Payload.Find();
            // The copy kept in the app's folder has no app inside it, so opening that one can only uninstall.
            if (options.Payload == null) options.Uninstall = true;
            return options;
        }
    }

    static class Program
    {
        const int Succeeded = 0;
        const int Failed = 1;
        const int EngineMissing = 2;

        [STAThread]
        static int Main(string[] arguments)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288;
            Options options;
            try
            {
                options = Options.Read(arguments);
            }
            catch (Problem problem)
            {
                MessageBox.Show(problem.Message, Product.Name, MessageBoxButton.OK, MessageBoxImage.Error);
                return Failed;
            }

            if (options.Uninstall && !options.Relocated) return Relocate(arguments);

            int result = options.Silent ? RunSilently(options) : RunWindow(options);
            if (options.Uninstall) RemoveThisCopyLater();
            return result;
        }

        // A running program can't delete itself, so the uninstaller works from a copy in the temp folder.
        static int Relocate(string[] arguments)
        {
            string copy = Path.Combine(Path.GetTempPath(), "OmniAgent-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
            File.Copy(Paths.Self, copy);
            var quoted = arguments.Select(argument => "\"" + argument + "\"").Concat(new[] { "--uninstall", "--relocated" });
            Process.Start(new ProcessStartInfo(copy, string.Join(" ", quoted)) { UseShellExecute = false });
            return Succeeded;
        }

        static void RemoveThisCopyLater()
        {
            string command = "/c ping -n 4 127.0.0.1 >nul & del /q \"" + Paths.Self + "\"";
            Process.Start(new ProcessStartInfo("cmd.exe", command) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
        }

        static int RunWindow(Options options)
        {
            var application = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            var screen = new Screen(options);
#if PREVIEW
            if (options.Preview != "")
            {
                application.Startup += (sender, args) => screen.Capture(options.Preview);
                return application.Run();
            }
#endif
            application.Startup += (sender, args) => screen.Show();
            return application.Run();
        }

        static int RunSilently(Options options)
        {
            var log = new List<string>();
            string last = "";
            Report report = (fraction, status) =>
            {
                if (status == last || status.StartsWith("Downloading") && last.StartsWith("Downloading")) return;
                last = status;
                log.Add(status);
            };

            int result = Succeeded;
            try
            {
                if (options.Uninstall)
                {
                    Setup.Uninstall(options.DeleteData, report);
                }
                else
                {
                    EngineSetup engines = Setup.Install(options.Payload, options.Engines, report, CancellationToken.None);
                    log.AddRange(engines.Details);
                    if (engines.Failed.Count > 0) result = EngineMissing;
                }
            }
            catch (Exception error)
            {
                log.Add("Failed: " + error.Message);
                result = Failed;
            }
            if (options.Log != "") File.WriteAllLines(options.Log, log);
            return result;
        }
    }
}
