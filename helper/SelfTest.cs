// SelfTest.cs — `pi-conpty-helper.exe --selftest [--variant=<name>]`.
//
// A portable smoke test for the pseudoconsole plumbing that needs neither the
// plugin, Node, nor a project directory: it starts `cmd.exe /c echo ...` in a
// ConPTY, reads the console output pipe, and reports what it found. Run it on a
// machine where the terminal misbehaves to learn whether the failure is below
// the plugin or inside it.
//
// It also prints the measured struct layout, the handle values and the list of
// processes attached to the helper's own console, because "the pseudoconsole
// attribute was dropped" is invisible otherwise: CreateProcess still succeeds
// and the shell quietly writes somewhere else.
//
// Exit code 0 means the production variant delivered the expected bytes.

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace PiConptyHelper;

internal static class SelfTest
{
    private const string Marker = "PI_CONPTY_SELFTEST_OK";
    private const uint WaitMs = 8000;
    private const int StdHandle = -1;

    private sealed class Variant
    {
        internal string Label = string.Empty;
        internal bool HideWindow = true;
        internal bool InheritEnvironment;
        internal bool KeepConsoleEnds;
        internal bool BogusConsole;
        internal bool RedirectStdHandles = true;
        internal bool ExpectSuccess = true;
    }

    /// <summary>
    /// `conpty` is what the plugin uses. The other presets exist to reproduce
    /// the failure modes this code was written against; they are not run by
    /// default.
    /// </summary>
    private static Dictionary<string, Variant> Presets()
    {
        return new Dictionary<string, Variant>(StringComparer.OrdinalIgnoreCase)
        {
            ["conpty"] = new Variant { Label = "conpty" },
            ["parent-std-handles"] = new Variant
            {
                Label = "parent-std-handles",
                RedirectStdHandles = false,
                InheritEnvironment = true,
                ExpectSuccess = false,
            },
            ["bogus-console"] = new Variant
            {
                Label = "bogus-console",
                BogusConsole = true,
                InheritEnvironment = true,
                ExpectSuccess = false,
            },
        };
    }

    internal static int Run(string[] args)
    {
        Console.Error.WriteLine("pi-conpty-helper self-test");
        Console.Error.WriteLine("  arch      : " + (Environment.Is64BitProcess ? "x64" : "x86"));
        Console.Error.WriteLine("  systemroot: " + (Environment.GetEnvironmentVariable("SystemRoot") ?? "<none>"));
        Console.Error.WriteLine("  cmd       : " + CmdPath());
        Console.Error.WriteLine(
            "  layout    : STARTUPINFO=" + Marshal.SizeOf<STARTUPINFO>().ToString()
            + " STARTUPINFOEX=" + Marshal.SizeOf<STARTUPINFOEX>().ToString()
            + " lpAttributeList@" + Marshal.OffsetOf<STARTUPINFOEX>("lpAttributeList").ToInt32().ToString()
            + " hStdInput@" + Marshal.OffsetOf<STARTUPINFO>("hStdInput").ToInt32().ToString()
            + " SECURITY_ATTRIBUTES=" + Marshal.SizeOf<SECURITY_ATTRIBUTES>().ToString());

        PipeLoopback();

        Dictionary<string, Variant> presets = Presets();
        var selected = new List<Variant>();
        foreach (string argument in args)
        {
            const string prefix = "--variant=";
            if (!argument.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string name = argument.Substring(prefix.Length);
            if (presets.TryGetValue(name, out Variant? preset))
            {
                selected.Add(preset);
            }
            else
            {
                Console.Error.WriteLine("unknown variant: " + name);
                return 1;
            }
        }

        if (selected.Count == 0)
        {
            selected.Add(presets["conpty"]);
        }

        bool all = true;
        foreach (Variant variant in selected)
        {
            bool ok = RunVariant(variant);
            bool acceptable = variant.ExpectSuccess ? ok : !ok;
            if (!acceptable)
            {
                all = false;
            }
        }

        Console.Error.WriteLine(all ? "SELFTEST PASS" : "SELFTEST FAIL");
        return all ? 0 : 1;
    }

    private static string CmdPath()
    {
        string root = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
        return root.TrimEnd('\\') + @"\System32\cmd.exe";
    }

    /// <summary>Validates CreatePipe/ReadFile/WriteFile plumbing without ConPTY.</summary>
    private static void PipeLoopback()
    {
        Console.Error.Write("  pipe loopback: ");
        IntPtr read = IntPtr.Zero;
        IntPtr write = IntPtr.Zero;
        try
        {
            var attributes = new SECURITY_ATTRIBUTES
            {
                nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(),
                lpSecurityDescriptor = IntPtr.Zero,
                bInheritHandle = 0,
            };

            if (!NativeMethods.CreatePipe(out read, out write, ref attributes, 0))
            {
                Console.Error.WriteLine("CreatePipe failed: " + Marshal.GetLastWin32Error().ToString());
                return;
            }

            byte[] payload = Encoding.ASCII.GetBytes("PIPE_LOOPBACK_OK");
            if (!NativeMethods.WriteFile(write, payload, (uint)payload.Length, out uint written, IntPtr.Zero))
            {
                Console.Error.WriteLine("WriteFile failed: " + Marshal.GetLastWin32Error().ToString());
                return;
            }

            var buffer = new byte[64];
            if (!NativeMethods.ReadFile(read, buffer, (uint)buffer.Length, out uint got, IntPtr.Zero))
            {
                Console.Error.WriteLine("ReadFile failed: " + Marshal.GetLastWin32Error().ToString());
                return;
            }

            string text = Encoding.ASCII.GetString(buffer, 0, (int)got);
            bool ok = written == payload.Length && text == "PIPE_LOOPBACK_OK";
            Console.Error.WriteLine((ok ? "OK (" : "MISMATCH (") + written.ToString() + " written, " + got.ToString() + " read)");
        }
        finally
        {
            if (read != IntPtr.Zero) NativeMethods.CloseHandle(read);
            if (write != IntPtr.Zero) NativeMethods.CloseHandle(write);
        }
    }

    /// <summary>
    /// Lists the processes attached to this process's own console. A child that
    /// shows up here after CreateProcess inherited our console, which is exactly
    /// what happens when the pseudoconsole attribute is ignored.
    /// </summary>
    private static void PrintConsoleProcessList(string when)
    {
        var list = new uint[64];
        uint count = NativeMethods.GetConsoleProcessList(list, (uint)list.Length);
        var text = new StringBuilder();
        for (uint index = 0; index < Math.Min(count, (uint)list.Length); index++)
        {
            text.Append(list[index].ToString()).Append(' ');
        }

        Console.Error.WriteLine("  console (" + when + "): [" + text.ToString().Trim() + "]");
    }

    private static bool RunVariant(Variant variant)
    {
        Console.Error.WriteLine("variant " + variant.Label + ":");

        IntPtr inputRead = IntPtr.Zero;
        IntPtr inputWrite = IntPtr.Zero;
        IntPtr outputRead = IntPtr.Zero;
        IntPtr outputWrite = IntPtr.Zero;
        IntPtr pseudoConsole = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;

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
                Console.Error.WriteLine("  CreatePipe(input) failed: " + Marshal.GetLastWin32Error().ToString());
                return false;
            }

            if (!NativeMethods.CreatePipe(out outputRead, out outputWrite, ref attributes, 0))
            {
                Console.Error.WriteLine("  CreatePipe(output) failed: " + Marshal.GetLastWin32Error().ToString());
                return false;
            }

            Console.Error.WriteLine(
                "  handles   : inRead=" + inputRead.ToString() + " inWrite=" + inputWrite.ToString()
                + " outRead=" + outputRead.ToString() + " outWrite=" + outputWrite.ToString());

            int hr = NativeMethods.CreatePseudoConsole(new COORD(80, 24), inputRead, outputWrite, 0, out pseudoConsole);
            Console.Error.WriteLine("  CreatePseudoConsole -> 0x" + hr.ToString("X8"));
            if (hr != 0)
            {
                return false;
            }

            IntPtr attributeSize = IntPtr.Zero;
            NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            attributeList = Marshal.AllocHGlobal(attributeSize);
            if (!NativeMethods.InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize))
            {
                Console.Error.WriteLine("  InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error().ToString());
                return false;
            }

            if (!NativeMethods.UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    (IntPtr)NativeMethods.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                    variant.BogusConsole ? new IntPtr(0xDEADBEEF) : pseudoConsole,
                    (IntPtr)IntPtr.Size,
                    IntPtr.Zero,
                    IntPtr.Zero))
            {
                Console.Error.WriteLine("  UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error().ToString());
                return false;
            }

            if (!variant.InheritEnvironment)
            {
                environment = ProcessEnvironment.Build(new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase), out _);
            }

            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf<STARTUPINFOEX>();
            startup.lpAttributeList = attributeList;
            if (variant.HideWindow)
            {
                startup.StartupInfo.dwFlags |= (int)NativeMethods.STARTF_USESHOWWINDOW;
                startup.StartupInfo.wShowWindow = NativeMethods.SW_HIDE;
            }

            if (variant.RedirectStdHandles)
            {
                // Ask the console subsystem for the console's own standard handles.
                startup.StartupInfo.dwFlags |= (int)NativeMethods.STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = new IntPtr(StdHandle);
                startup.StartupInfo.hStdOutput = new IntPtr(StdHandle);
                startup.StartupInfo.hStdError = new IntPtr(StdHandle);
            }

            uint flags = NativeMethods.EXTENDED_STARTUPINFO_PRESENT | NativeMethods.CREATE_UNICODE_ENVIRONMENT;
            string commandLine = "\"" + CmdPath() + "\" /c echo " + Marker;
            PrintConsoleProcessList("before");
            bool created = NativeMethods.CreateProcess(
                null,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                flags,
                environment,
                null,
                ref startup,
                out PROCESS_INFORMATION processInfo);

            Console.Error.WriteLine("  CreateProcess -> " + created.ToString() + " (error " + Marshal.GetLastWin32Error().ToString() + ")");
            if (created)
            {
                PrintConsoleProcessList("after");
            }

            if (!created)
            {
                return false;
            }

            Console.Error.WriteLine("  child pid : " + processInfo.dwProcessId.ToString());
            NativeMethods.CloseHandle(processInfo.hThread);

            if (!variant.KeepConsoleEnds)
            {
                NativeMethods.CloseHandle(inputRead);
                inputRead = IntPtr.Zero;
                NativeMethods.CloseHandle(outputWrite);
                outputWrite = IntPtr.Zero;
            }

            var collected = new List<byte>();
            var reader = new Thread(() =>
            {
                var buffer = new byte[4096];
                IntPtr handle = outputRead;
                while (true)
                {
                    if (!NativeMethods.ReadFile(handle, buffer, (uint)buffer.Length, out uint read, IntPtr.Zero))
                    {
                        int code = Marshal.GetLastWin32Error();
                        if (code != NativeMethods.ERROR_BROKEN_PIPE)
                        {
                            Console.Error.WriteLine("  ReadFile failed: " + code.ToString());
                        }

                        break;
                    }

                    if (read == 0)
                    {
                        break;
                    }

                    lock (collected)
                    {
                        for (uint index = 0; index < read; index++)
                        {
                            collected.Add(buffer[index]);
                        }
                    }
                }
            })
            {
                IsBackground = true,
            };
            reader.Start();

            NativeMethods.WaitForSingleObject(processInfo.hProcess, WaitMs);
            NativeMethods.GetExitCodeProcess(processInfo.hProcess, out uint exitCode);
            Thread.Sleep(300);
            reader.Join(1500);

            byte[] bytes;
            lock (collected)
            {
                bytes = collected.ToArray();
            }

            string text = Encoding.UTF8.GetString(bytes);
            bool ok = text.Contains(Marker, StringComparison.Ordinal);
            Console.Error.WriteLine("  exit code : " + exitCode.ToString());
            Console.Error.WriteLine("  bytes read: " + bytes.Length.ToString());
            Console.Error.WriteLine("  result    : " + (ok ? "marker received" : "NO MARKER"));
            if (!ok)
            {
                Console.Error.WriteLine("  raw       : " + text.Replace("\r", "\\r").Replace("\n", "\\n"));
            }

            if (!variant.ExpectSuccess)
            {
                Console.Error.WriteLine("  note      : this preset is expected to reproduce the failure");
            }

            NativeMethods.CloseHandle(processInfo.hProcess);
            return ok;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("  variant threw: " + ex);
            return false;
        }
        finally
        {
            if (inputRead != IntPtr.Zero) NativeMethods.CloseHandle(inputRead);
            if (outputWrite != IntPtr.Zero) NativeMethods.CloseHandle(outputWrite);
            if (attributeList != IntPtr.Zero)
            {
                NativeMethods.DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }

            ProcessEnvironment.Release(environment);
            if (pseudoConsole != IntPtr.Zero) NativeMethods.ClosePseudoConsole(pseudoConsole);
            if (inputWrite != IntPtr.Zero) NativeMethods.CloseHandle(inputWrite);
            if (outputRead != IntPtr.Zero) NativeMethods.CloseHandle(outputRead);
        }
    }
}
