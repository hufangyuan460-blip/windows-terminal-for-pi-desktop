// JsonLines.cs — the helper's wire format.
//
// One JSON object per line, UTF-8, LF terminated, in both directions:
//   plugin -> helper : requests {"id":"r1","op":"start", ...}
//   helper -> plugin : events   {"id":"r1","event":"ready", ...}
//
// Terminal payload never travels as text: `output` and `input` carry raw bytes
// as base64, so a multi-byte character split across two reads of the console
// pipe cannot be corrupted by a decoder boundary.

using System;
using System.Buffers;
using System.IO;
using System.Text;
using System.Text.Json;

namespace PiConptyHelper;

internal static class JsonLines
{
    private static readonly object WriteGate = new();
    private static Stream? _stdout;

    internal static void Attach(Stream stdout)
    {
        _stdout = stdout;
    }

    /// <summary>Writes one event object as a single JSON line on stdout.</summary>
    internal static void Emit(Action<Utf8JsonWriter> write)
    {
        Stream? target = _stdout;
        if (target == null)
        {
            return;
        }

        byte[] rented = ArrayPool<byte>.Shared.Rent(4096);
        try
        {
            int length;
            using (var buffer = new MemoryStream())
            {
                using (var writer = new Utf8JsonWriter(buffer))
                {
                    writer.WriteStartObject();
                    write(writer);
                    writer.WriteEndObject();
                }

                length = (int)buffer.Length + 1;
                if (length > rented.Length)
                {
                    ArrayPool<byte>.Shared.Return(rented);
                    rented = ArrayPool<byte>.Shared.Rent(length);
                }

                buffer.Position = 0;
                int read = 0;
                while (read < buffer.Length)
                {
                    int chunk = buffer.Read(rented, read, (int)buffer.Length - read);
                    if (chunk <= 0)
                    {
                        break;
                    }

                    read += chunk;
                }

                rented[read] = (byte)'\n';
                length = read + 1;
            }

            lock (WriteGate)
            {
                target.Write(rented, 0, length);
                target.Flush();
            }
        }
        catch (Exception ex)
        {
            Log.Warn("event write failed: " + ex.Message);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rented);
        }
    }

    internal static void EmitEvent(string? id, string name, Action<Utf8JsonWriter>? body = null)
    {
        Emit(writer =>
        {
            if (!string.IsNullOrEmpty(id))
            {
                writer.WriteString("id", id);
            }

            writer.WriteString("event", name);
            body?.Invoke(writer);
        });
    }

    internal static void EmitError(string? id, string code, string message)
    {
        Emit(writer =>
        {
            if (!string.IsNullOrEmpty(id))
            {
                writer.WriteString("id", id);
            }

            writer.WriteString("event", "error");
            writer.WriteString("code", code);
            writer.WriteString("message", message);
        });
    }

    internal static string? OptionalString(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value))
        {
            return null;
        }

        if (value.ValueKind == JsonValueKind.String)
        {
            return value.GetString();
        }

        if (value.ValueKind == JsonValueKind.Null || value.ValueKind == JsonValueKind.Undefined)
        {
            return null;
        }

        return value.ToString();
    }

    internal static int OptionalInt(JsonElement element, string name, int fallback)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value))
        {
            return fallback;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out int parsed))
        {
            return parsed;
        }

        if (value.ValueKind == JsonValueKind.String && int.TryParse(value.GetString(), out int text))
        {
            return text;
        }

        return fallback;
    }

    internal static byte[]? OptionalBytes(JsonElement element, string name)
    {
        string? text = OptionalString(element, name);
        if (text == null)
        {
            return null;
        }

        try
        {
            return Convert.FromBase64String(text);
        }
        catch (FormatException)
        {
            return null;
        }
    }

    internal static string ReadBase64(ReadOnlySpan<byte> bytes)
    {
        return Convert.ToBase64String(bytes);
    }

    internal static readonly UTF8Encoding Utf8NoBom = new(false, false);
}
