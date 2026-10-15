// PtySession.cs — one ConPTY pseudoconsole, one shell, one helper process.
//
// Ownership rules that make cleanup reliable:
//   * the shell process joins a Job Object created with KILL_ON_JOB_CLOSE, so
//     if this helper dies for any reason (crash, TerminateProcess, plugin gone)
//     the operating system closes the job handle and takes the whole shell tree
//     down with it — no orphaned console processes;
//   * stdin reaching EOF (the plugin process died) ends the request loop, which
//     disposes the session and closes the pseudoconsole;
//   * `close` terminates the job explicitly before the helper exits.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace PiConptyHelper;

internal sealed class PtySession : IDisposable
{
    private const int ReadBufferSize = 16 * 1024;
    private const int DrainGraceMs = 3000;

    private readonly ManualResetEventSlim _shellExited = new(false);
    private readonly ManualResetEventSlim _readerFinished = new(false);
    private readonly object _stateGate = new();

    private IntPtr _pseudoConsole = IntPtr.Zero;
    private IntPtr _inputWrite = IntPtr.Zero;
    private IntPtr _outputRead = IntPtr.Zero;
    private IntPtr _process = IntPtr.Zero;
    private IntPtr _job = IntPtr.Zero;
    private readonly uint _pid;
    private readonly string _shellPath;
    private readonly string _cwd;

    private Thread? _reader;
    private Thread? _waiter;
    private bool _disposed;
    private bool _exitReported;
    private uint _exitCode;

    private PtySession(
        IntPtr pseudoConsole,
        IntPtr inputWrite,
        IntPtr outputRead,
        IntPtr process,
        uint pid,
        string shellPath,
        string cwd)
    {
        _pseudoConsole = pseudoConsole;
        _inputWrite = inputWrite;
        _outputRead = outputRead;
        _process = process;
        _pid = pid;
        _shellPath = shellPath;
        _cwd = cwd;
    }

    internal bool ShellExited => _shellExited.IsSet;

    internal uint ExitCode => _exitCode;
    internal int Pid => (int)_pid;

    internal static PtySession? Start(
        string shellPath,
        IReadOnlyList<string> arguments,
        string? cwd,
        int columns,
        int rows,
        IReadOnlyDictionary<string, string> extras,
        out string? error)
    {
        error = null;

        if (string.IsNullOrWhiteSpace(shellPath))
        {
            error = "shell path is empty";
            return null;
        }

        short cols = Clamp(columns, 2, 1000);
        short lines = Clamp(rows, 2, 1000);

        IntPtr inputRead = IntPtr.Zero;
        IntPtr inputWrite = IntPtr.Zero;
        IntPtr outputRead = IntPtr.Zero;
        IntPtr outputWrite = IntPtr.Zero;
        IntPtr pseudoConsole = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        string[] environmentNames = Array.Empty<string>();

        try
        {
            var attributes = new SECURITY_ATTRIBUTES
            {
                nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(),
                lpSecurityDescriptor = IntPtr.Zero,
                bInheritHandle = 0,
            };

            if (!NativeMethods.CreatePipe(out inputRead, out inputWrite, ref attributes, 0))
            {
                error = "CreatePipe(input) failed: " + Win32Message();
                return null;
            }

            if (!NativeMethods.CreatePipe(out outputRead, out outputWrite, ref attributes, 0))
            {
                error = "CreatePipe(output) failed: " + Win32Message();
                return null;
            }

            int hr = NativeMethods.CreatePseudoConsole(new COORD(cols, lines), inputRead, outputWrite, 0, out pseudoConsole);
            if (hr != 0)
            {
                error = "CreatePseudoConsole failed: 0x" + hr.ToString("X8");
                return null;
            }

            // The console-side ends stay open until the child process exists:
            // the pseudoconsole only takes its own references while the client is
            // created, and closing them earlier leaves the console without a
            // usable input/output channel — the shell then silently falls back to
            // the helper's own console and the output pipe breaks immediately.

            IntPtr attributeSize = IntPtr.Zero;
            NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!NativeMethods.InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize))
            {
                error = "InitializeProcThreadAttributeList failed: " + Win32Message();
                return null;
            }

            if (!NativeMethods.UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    (IntPtr)NativeMethods.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                    pseudoConsole,
                    (IntPtr)IntPtr.Size,
                    IntPtr.Zero,
                    IntPtr.Zero))
            {
                error = "UpdateProcThreadAttribute failed: " + Win32Message();
                return null;
            }

            environment = ProcessEnvironment.Build(extras, out environmentNames);

            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf<STARTUPINFOEX>();
            startup.lpAttributeList = attributeList;
            // Without STARTF_USESTDHANDLES + INVALID_HANDLE_VALUE the console
            // subsystem leaves the child with the *parent's* standard handle
            // values: the shell then writes to the helper's console (or to the
            // plugin's pipes) instead of the pseudoconsole, and the console output
            // pipe breaks immediately. INVALID_HANDLE_VALUE asks for the console's
            // own handles, and SW_HIDE keeps conhost from flashing a window.
            startup.StartupInfo.dwFlags = (int)(NativeMethods.STARTF_USESHOWWINDOW | NativeMethods.STARTF_USESTDHANDLES);
            startup.StartupInfo.wShowWindow = NativeMethods.SW_HIDE;
            startup.StartupInfo.hStdInput = new IntPtr(-1);
            startup.StartupInfo.hStdOutput = new IntPtr(-1);
            startup.StartupInfo.hStdError = new IntPtr(-1);

            string commandLine = ComposeCommandLine(shellPath, arguments);
            bool created = NativeMethods.CreateProcess(
                null,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                NativeMethods.EXTENDED_STARTUPINFO_PRESENT | NativeMethods.CREATE_UNICODE_ENVIRONMENT,
                environment,
                string.IsNullOrWhiteSpace(cwd) ? null : cwd,
                ref startup,
                out PROCESS_INFORMATION processInfo);

            if (!created)
            {
                error = "CreateProcess failed for \"" + shellPath + "\": " + Win32Message();
                return null;
            }

            NativeMethods.CloseHandle(processInfo.hThread);

            // Only now is it safe to drop the console-side pipe ends: the
            // pseudoconsole has its own references to them, and holding ours open
            // any longer would keep EOF from ever reaching the read loop.
            NativeMethods.CloseHandle(inputRead);
            inputRead = IntPtr.Zero;
            NativeMethods.CloseHandle(outputWrite);
            outputWrite = IntPtr.Zero;

            var session = new PtySession(
                pseudoConsole,
                inputWrite,
                outputRead,
                processInfo.hProcess,
                (uint)processInfo.dwProcessId,
                shellPath,
                cwd ?? string.Empty);

            session.AttachToJob(processInfo.hProcess);
            pseudoConsole = IntPtr.Zero;
            inputWrite = IntPtr.Zero;
            outputRead = IntPtr.Zero;

            Log.Info(
                "session started pid=" + session._pid.ToString() +
                " cols=" + cols.ToString() +
                " rows=" + lines.ToString() +
                " cwd=" + (string.IsNullOrEmpty(cwd) ? "<inherit>" : cwd));

            session.StartPumps();
            return session;
        }
        catch (Exception ex)
        {
            error = ex.GetType().Name + ": " + ex.Message;
            return null;
        }
        finally
        {
            if (inputRead != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(inputRead);
            }

            if (outputWrite != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(outputWrite);
            }

            if (attributeList != IntPtr.Zero)
            {
                NativeMethods.DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }

            ProcessEnvironment.Release(environment);
            GC.KeepAlive(environmentNames);

            if (pseudoConsole != IntPtr.Zero)
            {
                NativeMethods.ClosePseudoConsole(pseudoConsole);
            }

            if (inputWrite != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(inputWrite);
            }

            if (outputRead != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(outputRead);
            }
        }
    }

    internal bool Write(byte[] data)
    {
        if (data.Length == 0)
        {
            return true;
        }

        lock (_stateGate)
        {
            if (_disposed || _inputWrite == IntPtr.Zero)
            {
                return false;
            }

            int offset = 0;
            while (offset < data.Length)
            {
                int remaining = data.Length - offset;
                var chunk = new byte[remaining];
                Buffer.BlockCopy(data, offset, chunk, 0, remaining);
                if (!NativeMethods.WriteFile(_inputWrite, chunk, (uint)remaining, out uint written, IntPtr.Zero))
                {
                    int code = Marshal.GetLastWin32Error();
                    if (code != NativeMethods.ERROR_BROKEN_PIPE)
                    {
                        Log.Warn("write to shell failed: " + new Win32Exception(code).Message);
                    }

                    return false;
                }

                if (written == 0)
                {
                    return false;
                }

                offset += (int)written;
            }

            return true;
        }
    }

    internal bool Resize(int columns, int rows)
    {
        short cols = Clamp(columns, 2, 1000);
        short lines = Clamp(rows, 2, 1000);

        lock (_stateGate)
        {
            if (_disposed || _pseudoConsole == IntPtr.Zero)
            {
                return false;
            }

            int hr = NativeMethods.ResizePseudoConsole(_pseudoConsole, new COORD(cols, lines));
            if (hr != 0)
            {
                Log.Warn("ResizePseudoConsole failed: 0x" + hr.ToString("X8"));
                return false;
            }

            return true;
        }
    }

    /// <summary>Ctrl+C without a console control handler dance: ConPTY turns a
    /// raw ETX byte in the input stream into the key event the shell expects.</summary>
    internal bool SendInterrupt()
    {
        return Write(new byte[] { 0x03 });
    }

    internal void Terminate(uint code)
    {
        lock (_stateGate)
        {
            if (_job != IntPtr.Zero)
            {
                NativeMethods.TerminateJobObject(_job, code);
                return;
            }

            if (_process != IntPtr.Zero)
            {
                NativeMethods.TerminateProcess(_process, code);
            }
        }
    }

    private void AttachToJob(IntPtr process)
    {
        try
        {
            IntPtr job = NativeMethods.CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                Log.Warn("CreateJobObject failed: " + Win32Message());
                return;
            }

            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, buffer, false);
                if (!NativeMethods.SetInformationJobObject(job, NativeMethods.JobObjectExtendedLimitInformation, buffer, (uint)size))
                {
                    Log.Warn("SetInformationJobObject failed: " + Win32Message());
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }

            if (!NativeMethods.AssignProcessToJobObject(job, process))
            {
                // A host job that forbids nesting still leaves the size and
                // exit-code paths intact; say so instead of failing the tab.
                Log.Warn("AssignProcessToJobObject failed: " + Win32Message());
                NativeMethods.CloseHandle(job);
                _job = IntPtr.Zero;
                return;
            }

            _job = job;
        }
        catch (Exception ex)
        {
            Log.Warn("job object setup failed: " + ex.Message);
        }
    }

    private void StartPumps()
    {
        _reader = new Thread(ReadLoop)
        {
            IsBackground = true,
            Name = "conpty-reader",
        };
        _reader.Start();

        _waiter = new Thread(WaitLoop)
        {
            IsBackground = true,
            Name = "conpty-waiter",
        };
        _waiter.Start();
    }

    private void ReadLoop()
    {
        var buffer = new byte[ReadBufferSize];
        try
        {
            while (true)
            {
                IntPtr handle;
                lock (_stateGate)
                {
                    handle = _outputRead;
                }

                if (handle == IntPtr.Zero)
                {
                    break;
                }

                if (!NativeMethods.ReadFile(handle, buffer, ReadBufferSize, out uint read, IntPtr.Zero))
                {
                    int code = Marshal.GetLastWin32Error();
                    if (code != NativeMethods.ERROR_BROKEN_PIPE && code != 0)
                    {
                        Log.Warn("read from console failed: " + new Win32Exception(code).Message);
                    }

                    break;
                }

                if (read == 0)
                {
                    break;
                }

                var copy = new byte[read];
                Buffer.BlockCopy(buffer, 0, copy, 0, (int)read);
                string payload = JsonLines.ReadBase64(copy);
                JsonLines.Emit(writer =>
                {
                    writer.WriteString("event", "output");
                    writer.WriteString("data", payload);
                });
            }
        }
        catch (Exception ex)
        {
            Log.Warn("reader loop ended: " + ex.Message);
        }
        finally
        {
            _readerFinished.Set();
            ReportExit();
        }
    }

    private void WaitLoop()
    {
        try
        {
            NativeMethods.WaitForSingleObject(_process, 0xFFFFFFFF);
            NativeMethods.GetExitCodeProcess(_process, out uint code);
            _exitCode = code;
            _shellExited.Set();
            Log.Info("shell exited code=" + code.ToString());
            _readerFinished.Wait(DrainGraceMs);
        }
        catch (Exception ex)
        {
            Log.Warn("waiter loop ended: " + ex.Message);
        }
        finally
        {
            ReportExit();
            Program.OnSessionFinished(this);
        }
    }

    private void ReportExit()
    {
        bool report;
        uint code;

        lock (_stateGate)
        {
            report = !_exitReported;
            if (report)
            {
                _exitReported = true;
            }

            code = _exitCode;
        }

        if (!report)
        {
            return;
        }

        if (_shellExited.IsSet)
        {
            JsonLines.Emit(writer =>
            {
                writer.WriteString("event", "exit");
                writer.WriteNumber("code", code);
            });
        }
        else
        {
            // The console closed without a process exit code (killed job, or the
            // pseudoconsole was torn down): report the fact, not a fake number.
            JsonLines.Emit(writer =>
            {
                writer.WriteString("event", "exit");
                writer.WriteNumber("code", code);
                writer.WriteBoolean("forced", true);
            });
        }
    }

    public void Dispose()
    {
        lock (_stateGate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
        }

        try
        {
            if (_job != IntPtr.Zero)
            {
                NativeMethods.TerminateJobObject(_job, 0);
            }
            else if (_process != IntPtr.Zero)
            {
                NativeMethods.TerminateProcess(_process, 0);
            }
        }
        catch (Exception ex)
        {
            Log.Warn("terminate failed: " + ex.Message);
        }

        try
        {
            _reader?.Join(1500);
        }
        catch
        {
            // ignored
        }

        lock (_stateGate)
        {
            if (_pseudoConsole != IntPtr.Zero)
            {
                NativeMethods.ClosePseudoConsole(_pseudoConsole);
                _pseudoConsole = IntPtr.Zero;
            }

            if (_inputWrite != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(_inputWrite);
                _inputWrite = IntPtr.Zero;
            }

            if (_outputRead != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(_outputRead);
                _outputRead = IntPtr.Zero;
            }

            if (_job != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(_job);
                _job = IntPtr.Zero;
            }

            if (_process != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(_process);
                _process = IntPtr.Zero;
            }
        }

        _shellExited.Dispose();
        _readerFinished.Dispose();
    }

    private static short Clamp(int value, short min, short max)
    {
        if (value < min)
        {
            return min;
        }

        return value > max ? max : (short)value;
    }

    private static string ComposeCommandLine(string shellPath, IReadOnlyList<string> arguments)
    {
        var builder = new StringBuilder();
        builder.Append('"').Append(shellPath).Append('"');
        foreach (string argument in arguments)
        {
            builder.Append(' ');
            if (argument.Length == 0 || argument.IndexOf(' ') >= 0 || argument.IndexOf('"') >= 0)
            {
                builder.Append('"').Append(argument.Replace("\"", "\\\"")).Append('"');
            }
            else
            {
                builder.Append(argument);
            }
        }

        return builder.ToString();
    }

    private static string Win32Message()
    {
        return new Win32Exception(Marshal.GetLastWin32Error()).Message;
    }
}
