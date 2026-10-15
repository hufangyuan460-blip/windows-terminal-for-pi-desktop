// ProcessEnvironment.cs — the environment block handed to the shell.
//
// The plugin process runs with a deliberately minimal environment (PI-Desktop
// keeps only a handful of variables), so a shell started with exactly that
// environment would look broken: no ComSpec, no PATHEXT, no APPDATA, a PATH
// that may miss the user's own additions. The helper therefore rebuilds a real
// user environment from the registry (machine values, then user values), then
// overlays whatever the plugin passed explicitly, and finally materialises the
// block of NUL-terminated UTF-16 strings CreateProcessW expects.

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

using System.Collections;
using System.IO;

namespace PiConptyHelper;

internal static class ProcessEnvironment
{
    private const string MachineEnvironmentKey = @"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";
    private const string UserEnvironmentKey = @"Environment";

    /// <summary>Builds an environment block for the shell process.</summary>
    internal static IntPtr Build(IReadOnlyDictionary<string, string> extras, out string[] names)
    {
        var merged = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        var machine = ReadKey(Registry.LocalMachine, MachineEnvironmentKey);
        foreach (var pair in machine)
        {
            merged[pair.Key] = Expand(pair.Value, merged);
        }

        var user = ReadKey(Registry.CurrentUser, UserEnvironmentKey);
        foreach (var pair in user)
        {
            merged[pair.Key] = Expand(pair.Value, merged);
        }

        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            if (entry.Key is string key && entry.Value is string value && key.Length > 0)
            {
                merged[key] = value;
            }
        }

        if (!merged.ContainsKey("Path") && machine.TryGetValue("Path", out string? machinePath))
        {
            merged["Path"] = user.TryGetValue("Path", out string? userPath) && userPath.Length > 0
                ? Expand(machinePath, merged) + ";" + Expand(userPath, merged)
                : Expand(machinePath, merged);
        }

        EnsureFallbacks(merged);

        foreach (var pair in extras)
        {
            if (string.IsNullOrEmpty(pair.Key))
            {
                continue;
            }

            merged[pair.Key] = pair.Value ?? string.Empty;
        }

        List<string> list = new List<string>(merged.Count);
        foreach (var pair in merged)
        {
            list.Add(pair.Key + "=" + pair.Value);
        }

        names = list.ToArray();
        return Compose(list);
    }

    internal static void Release(IntPtr block)
    {
        if (block != IntPtr.Zero)
        {
            Marshal.FreeHGlobal(block);
        }
    }

    private static IntPtr Compose(List<string> entries)
    {
        var builder = new StringBuilder();
        foreach (string entry in entries)
        {
            builder.Append(entry).Append('\0');
        }

        builder.Append('\0');
        return Marshal.StringToHGlobalUni(builder.ToString());
    }

    private static void EnsureFallbacks(SortedDictionary<string, string> values)
    {
        SetIfMissing(values, "ComSpec", () => SystemPath("cmd.exe"));
        SetIfMissing(values, "PATHEXT", () => ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC");
        SetIfMissing(values, "SystemRoot", () => Environment.GetEnvironmentVariable("SystemRoot") ?? SystemPath(string.Empty).TrimEnd('\\'));
        SetIfMissing(values, "windir", () => values.TryGetValue("SystemRoot", out string? root) ? root : SystemPath(string.Empty).TrimEnd('\\'));
        SetIfMissing(values, "SystemDrive", () => values.TryGetValue("SystemRoot", out string? root) && root.Length >= 2 ? root.Substring(0, 2) : "C:");
        SetIfMissing(values, "USERPROFILE", () => SafeFolder(Environment.SpecialFolder.UserProfile) ?? string.Empty);
        SetIfMissing(values, "APPDATA", () => SafeFolder(Environment.SpecialFolder.ApplicationData) ?? string.Empty);
        SetIfMissing(values, "LOCALAPPDATA", () => SafeFolder(Environment.SpecialFolder.LocalApplicationData) ?? string.Empty);
        SetIfMissing(values, "ProgramData", () => SafeFolder(Environment.SpecialFolder.CommonApplicationData) ?? string.Empty);
        SetIfMissing(values, "TEMP", () => values.TryGetValue("LOCALAPPDATA", out string? local) && local.Length > 0 ? local + @"\Temp" : Path.GetTempPath());
        SetIfMissing(values, "TMP", () => values.TryGetValue("TEMP", out string? temp) ? temp : Path.GetTempPath());
        SetIfMissing(values, "PSModulePath", () => ReadString(Registry.LocalMachine, MachineEnvironmentKey, "PSModulePath") ?? string.Empty);

        if (!values.ContainsKey("HOME") && values.TryGetValue("USERPROFILE", out string? profile) && profile.Length > 0)
        {
            values["HOME"] = profile;
        }
    }

    private static void SetIfMissing(SortedDictionary<string, string> values, string name, Func<string> factory)
    {
        if (values.TryGetValue(name, out string? existing) && existing.Length > 0)
        {
            return;
        }

        try
        {
            values[name] = factory();
        }
        catch (Exception ex)
        {
            Log.Warn("environment fallback " + name + " failed: " + ex.Message);
        }
    }

    private static string SystemPath(string leaf)
    {
        string root = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
        string basePath = root.TrimEnd('\\') + @"\System32";
        return leaf.Length == 0 ? basePath : basePath + "\\" + leaf;
    }

    private static string? SafeFolder(Environment.SpecialFolder folder)
    {
        try
        {
            string path = Environment.GetFolderPath(folder);
            return string.IsNullOrEmpty(path) ? null : path;
        }
        catch
        {
            return null;
        }
    }

    private static Dictionary<string, string> ReadKey(RegistryKey root, string subKey)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using RegistryKey? key = root.OpenSubKey(subKey);
            if (key == null)
            {
                return result;
            }

            foreach (string name in key.GetValueNames())
            {
                if (string.IsNullOrEmpty(name))
                {
                    continue;
                }

                object? value = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                if (value is string text)
                {
                    result[name] = text;
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn("registry read " + subKey + " failed: " + ex.Message);
        }

        return result;
    }

    private static string? ReadString(RegistryKey root, string subKey, string name)
    {
        try
        {
            using RegistryKey? key = root.OpenSubKey(subKey);
            object? value = key?.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
            return value as string;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Expands %NAME% references against the values collected so far.</summary>
    private static string Expand(string value, IDictionary<string, string> known)
    {
        if (value.IndexOf('%') < 0)
        {
            return value;
        }

        var builder = new StringBuilder(value.Length);
        int index = 0;
        while (index < value.Length)
        {
            char current = value[index];
            if (current != '%')
            {
                builder.Append(current);
                index++;
                continue;
            }

            int close = value.IndexOf('%', index + 1);
            if (close < 0)
            {
                builder.Append(value, index, value.Length - index);
                break;
            }

            string token = value.Substring(index + 1, close - index - 1);
            if (token.Length > 0 && known.TryGetValue(token, out string? replacement))
            {
                builder.Append(replacement);
            }
            else if (token.Length == 0)
            {
                builder.Append('%');
            }
            else
            {
                builder.Append(value, index, close - index + 1);
            }

            index = close + 1;
        }

        return builder.ToString();
    }
}
