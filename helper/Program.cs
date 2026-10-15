// Program.cs — the ConPTY helper entry point.
//
// The helper owns exactly one pseudoconsole for its whole life: one tab is one
// helper, so a stuck or crashed shell can never take another tab with it. The
// plugin drives it over stdin/stdout with JSON Lines and gets events back on
// the same stdout; diagnostics go to stderr.
//
// Requests
//   {"id":"r1","op":"hello"}
//   {"id":"r2","op":"start","shell":{"path":"...","args":["-NoLogo"]},
//    "cwd":"D:\\project","cols":120,"rows":30,"env":{"KEY":"VALUE"}}
//   {"id":"r3","op":"input","data":"<base64 bytes>"}
//   {"id":"r4","op":"resize","cols":100,"rows":30}
//   {"id":"r5","op":"signal","name":"int"}
//   {"id":"r6","op":"close"}
//
// Events
//   {"event":"hello","protocol":1,...}          object with no "event" field
//   {"id":"r2","event":"ready","pid":1,"cols":120,"rows":30}
//   {"id":"r3","event":"ok"}                    acknowledgement of a request
//   {"event":"output","data":"<base64 bytes>"}
//   {"event":"exit","code":0}
//   {"id":"rX","event":"error","code":"...","message":"..."}

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;

namespace PiConptyHelper;

internal static class Program
{
    private const int ProtocolVersion = 1;
    private const int MaxLineBytes = 8 * 1024 * 1024;

    private static readonly object SessionGate = new();
    private static PtySession? _session;
    private static volatile bool _shutdown;

    private static int Main(string[] args)
    {
        foreach (string argument in args)
        {
            if (string.Equals(argument, "--selftest", StringComparison.OrdinalIgnoreCase))
            {
                return SelfTest.Run(args);
            }
        }

        Log.Info("pi-conpty-helper starting pid=" + Environment.ProcessId.ToString());

        var stdout = Console.OpenStandardOutput();
        JsonLines.Attach(stdout);

        JsonLines.Emit(writer =>
        {
            writer.WriteString("event", "hello");
            writer.WriteNumber("protocol", ProtocolVersion);
            writer.WriteString("arch", Environment.Is64BitProcess ? "x64" : "x86");
            writer.WriteNumber("pid", Environment.ProcessId);
            writer.WriteString("version", typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0");
        });

        try
        {
            using var stdin = Console.OpenStandardInput();
            var reader = new StreamReader(stdin, JsonLines.Utf8NoBom, false, 64 * 1024, false);
            while (!_shutdown)
            {
                string? line = ReadLine(reader);
                if (line == null)
                {
                    Log.Info("stdin closed");
                    break;
                }

                if (line.Length == 0)
                {
                    continue;
                }

                HandleRequest(line);
            }
        }
        catch (Exception ex)
        {
            Log.Error("request loop failed: " + ex);
        }
        finally
        {
            Shutdown();
        }

        return 0;
    }

    /// <summary>Reads one line but refuses to buffer an unbounded one.</summary>
    private static string? ReadLine(StreamReader reader)
    {
        var builder = new StringBuilder(256);
        while (true)
        {
            int value = reader.Read();
            if (value < 0)
            {
                return builder.Length > 0 ? builder.ToString() : null;
            }

            if (value == '\n')
            {
                return builder.ToString();
            }

            if (value == '\r')
            {
                continue;
            }

            builder.Append((char)value);
            if (builder.Length > MaxLineBytes)
            {
                Log.Error("request line exceeds " + MaxLineBytes.ToString() + " bytes; dropping it");
                builder.Clear();
                int skipped;
                do
                {
                    skipped = reader.Read();
                }
                while (skipped >= 0 && skipped != '\n');

                return string.Empty;
            }
        }
    }

    private static void HandleRequest(string line)
    {
        using var document = JsonDocument.Parse(line);
        JsonElement request = document.RootElement;
        if (request.ValueKind != JsonValueKind.Object)
        {
            JsonLines.EmitError(null, "BAD_REQUEST", "request must be a JSON object");
            return;
        }

        string? id = JsonLines.OptionalString(request, "id");
        string op = JsonLines.OptionalString(request, "op") ?? string.Empty;

        switch (op)
        {
            case "hello":
                JsonLines.Emit(writer =>
                {
                    writer.WriteString("event", "hello");
                    writer.WriteNumber("protocol", ProtocolVersion);
                    writer.WriteString("arch", Environment.Is64BitProcess ? "x64" : "x86");
                    writer.WriteNumber("pid", Environment.ProcessId);
                    writer.WriteString("version", typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0");
                });
                break;

            case "start":
                StartSession(request, id);
                break;

            case "input":
                WithSession(id, session =>
                {
                    byte[]? data = JsonLines.OptionalBytes(request, "data");
                    if (data == null || data.Length == 0)
                    {
                        JsonLines.EmitError(id, "BAD_REQUEST", "input requires base64 data");
                        return;
                    }

                    if (session.Write(data))
                    {
                        JsonLines.EmitEvent(id, "ok");
                    }
                    else
                    {
                        JsonLines.EmitError(id, "WRITE_FAILED", "the shell input pipe is closed");
                    }
                });
                break;

            case "resize":
                WithSession(id, session =>
                {
                    int cols = JsonLines.OptionalInt(request, "cols", 0);
                    int rows = JsonLines.OptionalInt(request, "rows", 0);
                    if (cols <= 0 || rows <= 0)
                    {
                        JsonLines.EmitError(id, "BAD_REQUEST", "resize requires positive cols and rows");
                        return;
                    }

                    if (session.Resize(cols, rows))
                    {
                        JsonLines.EmitEvent(id, "ok", writer =>
                        {
                            writer.WriteNumber("cols", cols);
                            writer.WriteNumber("rows", rows);
                        });
                    }
                    else
                    {
                        JsonLines.EmitError(id, "RESIZE_FAILED", "the pseudoconsole refused the new size");
                    }
                });
                break;

            case "signal":
                WithSession(id, session =>
                {
                    string name = (JsonLines.OptionalString(request, "name") ?? "int").ToLowerInvariant();
                    if (name != "int" && name != "interrupt")
                    {
                        JsonLines.EmitError(id, "UNSUPPORTED_SIGNAL", "only the interrupt signal is supported");
                        return;
                    }

                    if (session.SendInterrupt())
                    {
                        JsonLines.EmitEvent(id, "ok");
                    }
                    else
                    {
                        JsonLines.EmitError(id, "WRITE_FAILED", "the shell input pipe is closed");
                    }
                });
                break;

            case "close":
                PtySession? closing;
                lock (SessionGate)
                {
                    closing = _session;
                }

                if (closing == null)
                {
                    JsonLines.EmitEvent(id, "ok");
                    return;
                }

                Log.Info("close requested");
                closing.Dispose();
                JsonLines.EmitEvent(id, "ok");
                break;

            case "ping":
                JsonLines.EmitEvent(id, "pong");
                break;

            default:
                JsonLines.EmitError(id, "UNKNOWN_OP", "unknown op: " + op);
                break;
        }
    }

    private static void StartSession(JsonElement request, string? id)
    {
        lock (SessionGate)
        {
            if (_session != null)
            {
                JsonLines.EmitError(id, "ALREADY_STARTED", "this helper already owns a session");
                return;
            }
        }

        string shellPath = JsonLines.OptionalString(request, "shellPath") ?? string.Empty;
        if (shellPath.Length == 0 && request.TryGetProperty("shell", out JsonElement shell) && shell.ValueKind == JsonValueKind.Object)
        {
            shellPath = JsonLines.OptionalString(shell, "path") ?? string.Empty;
        }

        var arguments = new List<string>();
        if (request.TryGetProperty("args", out JsonElement args) && args.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement entry in args.EnumerateArray())
            {
                if (entry.ValueKind == JsonValueKind.String)
                {
                    string? argument = entry.GetString();
                    if (!string.IsNullOrEmpty(argument))
                    {
                        arguments.Add(argument);
                    }
                }
            }
        }

        string? cwd = JsonLines.OptionalString(request, "cwd");
        int cols = JsonLines.OptionalInt(request, "cols", 80);
        int rows = JsonLines.OptionalInt(request, "rows", 24);

        var extras = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (request.TryGetProperty("env", out JsonElement env) && env.ValueKind == JsonValueKind.Object)
        {
            foreach (JsonProperty property in env.EnumerateObject())
            {
                if (property.Value.ValueKind == JsonValueKind.String)
                {
                    extras[property.Name] = property.Value.GetString() ?? string.Empty;
                }
            }
        }

        if (string.IsNullOrWhiteSpace(shellPath))
        {
            JsonLines.EmitError(id, "BAD_REQUEST", "start requires shellPath");
            return;
        }

        PtySession? session = PtySession.Start(shellPath, arguments, cwd, cols, rows, extras, out string? error);
        if (session == null)
        {
            JsonLines.EmitError(id, "START_FAILED", error ?? "the pseudoconsole could not be created");
            return;
        }

        lock (SessionGate)
        {
            _session = session;
        }

        JsonLines.EmitEvent(id, "ready", writer =>
        {
            writer.WriteNumber("pid", session.Pid);
            writer.WriteNumber("cols", cols);
            writer.WriteNumber("rows", rows);
            writer.WriteString("shell", shellPath);
            writer.WriteString("cwd", cwd ?? string.Empty);
        });

        if (session.ShellExited)
        {
            // The shell died before the ready event; the exit event follows.
            Log.Info("shell exited during start");
        }
    }

    private static void WithSession(string? id, Action<PtySession> action)
    {
        PtySession? session;
        lock (SessionGate)
        {
            session = _session;
        }

        if (session == null)
        {
            JsonLines.EmitError(id, "NO_SESSION", "no session has been started");
            return;
        }

        try
        {
            action(session);
        }
        catch (Exception ex)
        {
            JsonLines.EmitError(id, "REQUEST_FAILED", ex.GetType().Name + ": " + ex.Message);
        }
    }

    /// <summary>Called by a session once its shell is gone.</summary>
    internal static void OnSessionFinished(PtySession session)
    {
        Log.Info("session finished; helper exiting");
        lock (SessionGate)
        {
            if (ReferenceEquals(_session, session))
            {
                _session = null;
            }
        }

        try
        {
            session.Dispose();
        }
        catch (Exception ex)
        {
            Log.Warn("session dispose failed: " + ex.Message);
        }

        _shutdown = true;
        Environment.Exit(0);
    }

    private static void Shutdown()
    {
        PtySession? session;
        lock (SessionGate)
        {
            session = _session;
            _session = null;
        }

        if (session != null)
        {
            Log.Info("shutting down with a live session");
            try
            {
                session.Dispose();
            }
            catch (Exception ex)
            {
                Log.Warn("shutdown dispose failed: " + ex.Message);
            }
        }
    }
}
