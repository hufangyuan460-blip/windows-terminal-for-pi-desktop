// Log.cs — diagnostics go to stderr only.
//
// stdout is the protocol channel and must stay pure JSON Lines: anything the
// plugin cannot parse would be read as a protocol error. stderr is free-form
// text and is surfaced by the plugin as a diagnostic log line.

using System;
using System.Globalization;

namespace PiConptyHelper;

internal static class Log
{
    internal static void Write(string level, string message)
    {
        try
        {
            Console.Error.WriteLine(
                string.Format(
                    CultureInfo.InvariantCulture,
                    "[{0}] {1} {2}",
                    DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture),
                    level,
                    message));
            Console.Error.Flush();
        }
        catch
        {
            // A closed stderr must never take the session down.
        }
    }

    internal static void Info(string message) => Write("info", message);

    internal static void Warn(string message) => Write("warn", message);

    internal static void Error(string message) => Write("error", message);
}
