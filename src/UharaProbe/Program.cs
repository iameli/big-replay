using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

/// <summary>
/// One-shot probe: drives the REAL uhhara component (the same binary LiveSplit ships) to resolve
/// static blocks + field offsets for the recorder's classes. Emphasis on: exactly the mechanism the
/// community runs — if this crashes the game, uhhara-in-LiveSplit's safety is re-examined;
/// if it survives, we adopt this resolution wholesale.
///
/// Usage: UharaProbe.exe <LiveSplitComponentsDir> <pid> <out.json>
/// </summary>
internal static class Program
{
    private static readonly List<(string Cls, string[] Statics, string[] Instances)> Targets = new()
    {
        ("PlayerCharacter", new[] { "allPlayerCharacters" }, new[] { "mover", "playerNetworking", "registry", "sleeper", "bypassUpdate" }),
        ("PlayerNetworking", new[] { "playerCount" }, new[] { "isPending" }),
        ("PropHome", new[] { "allPropHomes" }, new[] { "onPin", "pinGroup", "pinnedProp", "saveableHomeName", "parentCharacter" }),
        ("Prop", new[] { "allProps" }, new[] { "saveablePropName", "exclusiveHolder" }),
        ("Corpse", new[] { "allCorpses" }, Array.Empty<string>()),
        ("PlayerSleeper", Array.Empty<string>(), new[] { "timeTilSleep" }),
        ("PeckSwitch", Array.Empty<string>(), new[] { "trackedStateSystem" }),
        ("TrackedPeckState", new[] { "eventName" }, new[] { "currentPeckContext" }),
        ("PeckContext", Array.Empty<string>(), new[] { "playerIdentity", "propIdentity", "compressedState", "actionNumber" }),
        ("MainMenuManager", new[] { "entryMode" }, new[] { "cameraController", "connectCancellation", "monitorController", "mainMenu", "bots", "entryCameraRig", "cameraSequencePlayer", "entryCameraTransform", "ReferenceCameras", "lobbyViewModel", "usernameTitle" }),
        ("Mirror:Mirror:NetworkIdentity", new[] { "MaxNetworkBehaviours", "nextNetworkId" }, new[] { "<netId>k__BackingField", "<isLocalPlayer>k__BackingField" }),
        ("Mirror:Mirror:NetworkBehaviour", Array.Empty<string>(), new[] { "<netIdentity>k__BackingField" }),
        ("Mirror:Mirror:NetworkClient", new[] { "connectState", "ready", "handlers", "spawned" }, new[] { "connection", "isConnected", "isLoadingScene", "isReady" }),
        ("Mirror:Mirror:NetworkServer", new[] { "<active>k__BackingField", "dontListen", "maxConnections", "tickRate", "connections", "spawned" }, new[] { "active", "isLoadingScene" }),
    };

    private static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine("usage: UharaProbe.exe <componentsDir> <pid> <out.json>");
            return 1;
        }
        string components = Path.GetFullPath(args[0]);
        int pid = int.Parse(args[1]);
        string outJson = args[2];

        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            string name = (e.Name ?? "").Split(',')[0];
            foreach (string cand in new[] { Path.Combine(components, name + ".dll"), Path.Combine(components, name) })
            {
                if (File.Exists(cand))
                {
                    return Assembly.LoadFrom(cand);
                }
            }
            return null;
        };

        try
        {
            var asm = Assembly.LoadFrom(Path.Combine(components, "uhara10"));
            dynamic main = Activator.CreateInstance(asm.GetType("Main"));
            dynamic tool = main.CreateTool("Unity", "IL2CPP", "Instance");
            Console.WriteLine("instance tool created; resolving…");

            var sb = new StringBuilder();
            sb.Append("{\n  \"statics\": {\n");
            var staticsRows = new List<string>();
            var instanceRows = new List<string>();

            foreach (var (cls, statics, insts) in Targets)
            {
                string shortName = cls.Contains(':') ? cls.Substring(cls.LastIndexOf(':') + 1) : cls;
                // static blocks + static offsets
                foreach (string f in statics)
                {
                    string uid = "st_" + shortName + "_" + f;
                    try
                    {
                        tool.Watch(typeof(IntPtr), uid, cls, f);
                        IntPtr slot = (IntPtr)tool.AskPtr(uid);
                        int off = (int)tool.GetPathInt(cls, f);
                        long block = slot.ToInt64() - off;
                        staticsRows.Add($"      \"{shortName}.{f}\": {{\"slot\": \"0x{slot.ToInt64():X}\", \"offset\": 0x{off:X}, \"block\": \"0x{block:X}\"}}");
                        Console.WriteLine($"  static {shortName}.{f}: slot=0x{slot.ToInt64():X} off=0x{off:X} block=0x{block:X}");
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"  static {shortName}.{f}: FAILED {ex.Message}");
                    }
                }
                // instance field offsets
                foreach (string f in insts)
                {
                    try
                    {
                        int off = (int)tool.GetPathInt(cls, f);
                        instanceRows.Add($"      \"{shortName}.{f}\": 0x{off:X}");
                        Console.WriteLine($"  field  {shortName}.{f}: 0x{off:X}");
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"  field  {shortName}.{f}: FAILED {ex.Message}");
                    }
                }
            }

            sb.Append(string.Join(",\n", staticsRows));
            sb.Append("\n  },\n  \"instances\": {\n");
            sb.Append(string.Join(",\n", instanceRows));
            sb.Append("\n  }\n}\n");
            File.WriteAllText(outJson, sb.ToString());
            Console.WriteLine("wrote " + outJson);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("FATAL: " + ex);
            return 2;
        }
    }

    // tiny self-contained reader for sanity values
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, uint size, out uint read);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);
}