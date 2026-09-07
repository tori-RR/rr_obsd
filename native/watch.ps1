# Windows PowerShell 5.1 / .NET Framework. No disk writes in the watched root.
# Start via -NoProfile -NonInteractive -EncodedCommand; pass paths only in env.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Threading;

public sealed class VaultWatchBridge : IDisposable {
    sealed class Change {
        public string Kind, Path, OldPath;
        public Change(string kind, string path, string oldPath) {
            Kind = kind; Path = path; OldPath = oldPath;
        }
    }
    readonly string root, prefix;
    readonly object gate = new object();
    readonly Queue<Change> queue = new Queue<Change>();
    readonly HashSet<string> updates = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    FileSystemWatcher watcher;
    int generation;
    bool overflow;
    string fault;
    const int Capacity = 2048;

    VaultWatchBridge(string path) {
        if (String.IsNullOrWhiteSpace(path) ||
            !(path.StartsWith(@"\\") ||
              (path.Length >= 3 && Char.IsLetter(path[0]) && path[1] == ':' &&
               (path[2] == '\\' || path[2] == '/'))))
            throw new ArgumentException("An absolute Windows vault path is required.");
        root = System.IO.Path.GetFullPath(path);
        prefix = root.TrimEnd('\\', '/') + System.IO.Path.DirectorySeparatorChar;
    }

    // Framework 4.x does not provide Path.GetRelativePath.
    string Relative(string full) {
        try {
            string normal = System.IO.Path.GetFullPath(full);
            if (!normal.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
            string relative = normal.Substring(prefix.Length).Replace('\\', '/');
            return relative.Length == 0 ? null : relative;
        } catch { return null; }
    }

    void Enqueue(int ticket, string kind, string full, string oldFull) {
        string path = Relative(full);
        string oldPath = oldFull == null ? null : Relative(oldFull);
        if (path == null || (kind == "rename" && oldPath == null)) return;
        lock (gate) {
            if (ticket != generation || fault != null || overflow) return;
            if (kind == "update" && !updates.Add(path)) return;
            if (queue.Count >= Capacity) {
                queue.Clear(); updates.Clear(); overflow = true; return;
            }
            // Structural events delimit update deduplication for this path.
            if (kind != "update") {
                updates.Remove(path);
                if (oldPath != null) updates.Remove(oldPath);
            }
            queue.Enqueue(new Change(kind, path, oldPath));
        }
    }

    void Start() {
        // Enumerate at least one entry: Directory.Exists alone hides access errors.
        using (var items = Directory.EnumerateFileSystemEntries(root).GetEnumerator())
            items.MoveNext();
        int ticket;
        lock (gate) {
            ticket = ++generation;
            fault = null; overflow = false; queue.Clear(); updates.Clear();
        }
        var next = new FileSystemWatcher(root);
        try {
            next.IncludeSubdirectories = true;
            next.InternalBufferSize = 16384;
            next.NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName |
                NotifyFilters.LastWrite | NotifyFilters.Size;
            next.Created += (s, e) => Enqueue(ticket, "create", e.FullPath, null);
            next.Changed += (s, e) => Enqueue(ticket, "update", e.FullPath, null);
            next.Deleted += (s, e) => Enqueue(ticket, "delete", e.FullPath, null);
            next.Renamed += (s, e) => Enqueue(ticket, "rename", e.FullPath, e.OldFullPath);
            next.Error += (s, e) => {
                lock (gate) {
                    if (ticket != generation) return;
                    if (e.GetException() is InternalBufferOverflowException) {
                        queue.Clear(); updates.Clear(); overflow = true;
                    } else {
                        fault = e.GetException().GetType().Name;
                    }
                }
            };
            next.EnableRaisingEvents = true;
            watcher = next;
        } catch { next.Dispose(); throw; }
    }

    public void Dispose() {
        var current = watcher;
        watcher = null;
        lock (gate) {
            generation++; queue.Clear(); updates.Clear(); fault = null; overflow = false;
        }
        if (current != null) current.Dispose();
    }

    static string Json(string value) {
        if (value == null) return "null";
        var text = new StringBuilder("\"");
        foreach (char c in value) {
            if (c == '"' || c == '\\') text.Append('\\').Append(c);
            else if (c < 32) text.Append("\\u").Append(((int)c).ToString("x4"));
            else text.Append(c);
        }
        return text.Append('"').ToString();
    }

    static void Emit(string json) {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }

    static void GuardParent(Process parent) {
        // Holding the original process handle avoids accidentally following a reused PID.
        var handle = parent.Handle;
        var guardian = new Thread(() => {
            try {
                while (!parent.HasExited) Thread.Sleep(250);
            } catch { }
            // Also works if a disconnected SMB call is blocked; OS releases all handles.
            Environment.Exit(0);
        });
        guardian.IsBackground = true;
        guardian.Start();
        var input = new Thread(() => {
            try {
                var stdin = Console.OpenStandardInput();
                while (stdin.ReadByte() != -1) { }
            } catch { }
            Environment.Exit(0);
        });
        input.IsBackground = true;
        input.Start();
    }

    public static void Run() {
        int parentId;
        if (!Int32.TryParse(Environment.GetEnvironmentVariable("OVW_PARENT_PID"), out parentId) ||
            parentId <= 0 || parentId == Process.GetCurrentProcess().Id)
            throw new ArgumentException("A valid parent process ID is required.");
        using (var parent = Process.GetProcessById(parentId))
        using (var bridge = new VaultWatchBridge(Environment.GetEnvironmentVariable("OVW_ROOT"))) {
            GuardParent(parent);
            var clock = Stopwatch.StartNew();
            long nextRetry = 0, nextHeartbeat = 0, nextHealth = 0;
            int backoff = 1000;
            bool disconnected = false, everReady = false;
            while (true) {
                long now = clock.ElapsedMilliseconds;
                if (now >= nextHeartbeat) {
                    Emit("{\"type\":\"heartbeat\"}"); nextHeartbeat = now + 2000;
                }
                if (bridge.watcher == null && now >= nextRetry) {
                    try {
                        bridge.Start();
                        if (!everReady) { Emit("{\"type\":\"ready\"}"); everReady = true; }
                        else if (disconnected) Emit("{\"type\":\"rescan\",\"reason\":\"reconnected\"}");
                        disconnected = false; backoff = 1000; nextHealth = now + 5000;
                    } catch (Exception e) {
                        if (!disconnected) Emit("{\"type\":\"offline\",\"reason\":" + Json(e.GetType().Name) + "}");
                        disconnected = true; nextRetry = now + backoff;
                        backoff = Math.Min(backoff * 2, 30000);
                    }
                }
                if (bridge.watcher != null) {
                    // Detect root disappearance even if the server drops Error events.
                    if (now >= nextHealth) {
                        try {
                            using (var items = Directory.EnumerateFileSystemEntries(bridge.root).GetEnumerator())
                                items.MoveNext();
                        } catch (Exception e) {
                            lock (bridge.gate) { bridge.fault = e.GetType().Name; }
                        }
                        nextHealth = now + 5000;
                    }
                    string error;
                    bool lost;
                    Change[] changes;
                    lock (bridge.gate) {
                        error = bridge.fault; lost = bridge.overflow;
                        changes = bridge.queue.ToArray();
                        bridge.queue.Clear(); bridge.updates.Clear(); bridge.overflow = false;
                    }
                    if (error != null) {
                        bridge.Dispose(); disconnected = true; nextRetry = now + backoff;
                        Emit("{\"type\":\"offline\",\"reason\":" + Json(error) + "}");
                    } else if (lost) {
                        Emit("{\"type\":\"rescan\",\"reason\":\"overflow\"}");
                    } else {
                        foreach (var change in changes) {
                            Emit("{\"type\":\"change\",\"kind\":" + Json(change.Kind) +
                                ",\"path\":" + Json(change.Path) +
                                (change.OldPath == null ? "" : ",\"oldPath\":" + Json(change.OldPath)) + "}");
                        }
                    }
                }
                Thread.Sleep(100);
            }
        }
    }
}
'@
    [VaultWatchBridge]::Run()
} catch {
    # Keep stdout machine-readable and avoid leaking local paths in exception text.
    [Console]::Out.WriteLine('{"type":"error","message":"Native watcher could not start. Check Windows PowerShell and .NET availability, vault path, and parent process."}')
    exit 1
}
