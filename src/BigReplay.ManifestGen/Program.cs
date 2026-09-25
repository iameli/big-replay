using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using AssetRipper.Primitives;
using LibCpp2IL;
using LibCpp2IL.BinaryStructures;
using LibCpp2IL.Metadata;

namespace BigReplay.ManifestGen;

/// <summary>
/// Generates the per-build manifest the recorder needs: instance field offsets, per-class identity
/// (namespace, type index), ordered static-field lists with aligned block offsets, and binary RVAs.
///
///   dotnet run --project src/BigReplay.ManifestGen -- <gameFolder> [out.json]
/// </summary>
internal static class Program
{
    // (image, className, field names) — parallel to the recorder's GameLayout.
    private static readonly (string Image, string Class, string[] Fields)[] Wanted =
    [
        ("Assembly-CSharp.dll", "PlayerCharacter", ["allPlayerCharacters", "mover", "playerNetworking", "registry", "sleeper", "bypassUpdate"]),
        ("Assembly-CSharp.dll", "PlayerNetworking", ["isPending", "username", "identifier"]),
        ("Assembly-CSharp.dll", "PropHome", ["allPropHomes", "onPin", "pinGroup", "pinnedProp", "saveableHomeName", "parentCharacter"]),
        ("Assembly-CSharp.dll", "Prop", ["allProps", "saveablePropName", "exclusiveHolder"]),
        ("Assembly-CSharp.dll", "Corpse", ["allCorpses"]),
        ("Assembly-CSharp.dll", "PlayerSleeper", ["timeTilSleep"]),
        ("Assembly-CSharp.dll", "PeckSwitch", ["trackedStateSystem"]),
        ("Assembly-CSharp.dll", "TrackedPeckState", ["currentPeckContext"]),
        ("Assembly-CSharp.dll", "PeckContext", ["playerIdentity", "propIdentity", "compressedState", "actionNumber"]),
        ("Assembly-CSharp.dll", "MainMenuManager", ["entryMode"]),
        ("Mirror.dll", "NetworkIdentity", ["<netId>k__BackingField", "<isLocalPlayer>k__BackingField"]),
        ("Mirror.dll", "NetworkBehaviour", ["<netIdentity>k__BackingField"]),
        ("Mirror.dll", "NetworkClient", ["connectState"]),
        ("Mirror.dll", "NetworkServer", ["<active>k__BackingField"]),
    ];

    private const string GameVersion = "1.5.1 2608271531";
    private const long BuildId = 24982892;
    private const string UnityVersionString = "6000.3.17f1";

    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("usage: BigReplay.ManifestGen <gameFolder> [out.json]");
            return 1;
        }
        string gameFolder = args[0];
        string outPath = args.Length > 1 ? args[1] : "manifest.json";

        string gameAssemblyPath = Path.Combine(gameFolder, "GameAssembly.dll");
        string metadataPath = Path.Combine(gameFolder, "Big Walk_Data", "il2cpp_data", "Metadata", "global-metadata.dat");
        if (!File.Exists(gameAssemblyPath) || !File.Exists(metadataPath))
        {
            Console.Error.WriteLine($"game files missing: {gameAssemblyPath} / {metadataPath}");
            return 2;
        }

        var assemblyBytes = File.ReadAllBytes(gameAssemblyPath);
        var metadataBytes = File.ReadAllBytes(metadataPath);
        var (imageBase, sizeOfImage) = ParsePe(assemblyBytes);

        var unity = UnityVersion.Parse(UnityVersionString);
        if (!LibCpp2IlMain.Initialize(assemblyBytes, metadataBytes, unity))
        {
            Console.Error.WriteLine("LibCpp2IL initialization failed");
            return 3;
        }
        var binary = LibCpp2IlMain.Binary!;
        var metadata = LibCpp2IlMain.TheMetadata!;

        var (_, metareg) = binary.FindCodeAndMetadataReg(metadata);
        ulong metaregRva = metareg - imageBase;

        // probe the registration struct from the raw bytes for runtime validation constants
        ulong rva = metaregRva;
        ulong types = ReadPtr(assemblyBytes, rva + 0x38) - imageBase;
        ulong fieldOffsets = ReadPtr(assemblyBytes, rva + 0x58) - imageBase;
        ulong typeDefSizes = ReadPtr(assemblyBytes, rva + 0x68) - imageBase;
        uint typesCount = (uint)ReadQword(assemblyBytes, rva + 0x30);
        uint fieldOffsetsCount = (uint)ReadQword(assemblyBytes, rva + 0x50);
        uint typeDefSizesCount = (uint)ReadQword(assemblyBytes, rva + 0x60);

        var manifest = new Manifest
        {
            FormatVersion = 1,
            GameVersion = GameVersion,
            BuildId = BuildId,
            UnityVersion = UnityVersionString,
            ImageBase = imageBase,
            ImageSize = sizeOfImage,
            MetaregRva = metaregRva,
            TypesTableRva = types,
            FieldOffsetsTableRva = fieldOffsets,
            TypeDefSizesTableRva = typeDefSizes,
            TypesCount = typesCount,
            FieldOffsetsCount = fieldOffsetsCount,
            TypeDefSizesCount = typeDefSizesCount,
            Classes = new Dictionary<string, ClassEntry>(),
        };

        foreach (var (imageName, className, fieldNames) in Wanted)
        {
            var image = metadata.imageDefinitions.FirstOrDefault(img => img.Name == imageName);
            if (image is null)
            {
                Console.Error.WriteLine($"image '{imageName}' not found");
                return 4;
            }
            var td = image.Types!.FirstOrDefault(t => t.Name == className);
            if (td is null)
            {
                Console.Error.WriteLine($"type '{imageName}.{className}' not found");
                return 5;
            }

            var fields = td.FieldInfos!;
            var fieldInfos = new List<FieldEntry>();
            foreach (var wanted in fieldNames)
            {
                int idx = Array.FindIndex(fields, f => f.Field.Name == wanted);
                if (idx < 0)
                {
                    Console.Error.WriteLine($"field '{imageName}.{className}.{wanted}' not found");
                    return 6;
                }
                var fi = fields[idx];
                bool isStatic = fi.Attributes.HasFlag(FieldAttributes.Static);
                fieldInfos.Add(new FieldEntry { Name = wanted, Offset = fi.FieldOffset, IsStatic = isStatic });
            }

            var allStatics = fields
                .Where(fi => fi.Attributes.HasFlag(FieldAttributes.Static))
                .Select(fi => new StaticEntry { Name = fi.Field.Name, Size = SizeOf(fi.Field.RawFieldType!, assemblyBytes, typeDefSizes) })
                .ToList();

            // aligned static-block layout: declaration order, natural alignment by size
            int cur = 0;
            foreach (var s in allStatics)
            {
                int align = s.Size switch { >= 8 => 8, >= 4 => 4, >= 2 => 2, _ => 1 };
                cur = (cur + align - 1) / align * align;
                s.Offset = cur;
                cur += s.Size;
            }

            var entry = new ClassEntry
            {
                Image = imageName,
                Namespace = td.Namespace ?? "",
                TypeIndex = td.TypeIndex.Value,
                TypeDefIndex = Array.IndexOf(metadata.typeDefs, td),
                IsValueType = td.IsValueType,
                Fields = fieldInfos,
                Statics = allStatics,
            };
            manifest.Classes[className] = entry;
            Console.WriteLine($"  {className}: typeIndex={entry.TypeIndex} ns='{entry.Namespace}' vt={entry.IsValueType}");
            foreach (var f in fieldInfos)
            {
                Console.WriteLine($"    {(f.IsStatic ? "static " : "field  ")} {f.Name} @ 0x{f.Offset:X}");
            }
            if (allStatics.Count > 0)
            {
                Console.WriteLine($"    statics: {string.Join(", ", allStatics.Select(s => $"{s.Name}({s.Size}B@0x{s.Offset:X})"))}");
            }
        }

        File.WriteAllText(outPath, JsonSerializer.Serialize(manifest, Json));
        Console.WriteLine($"\nwrote {outPath}");
        return 0;
    }

    private static int SizeOf(Il2CppType t, byte[] assemblyBytes, ulong typeDefSizesRva)
    {
        var type = t.Type;
        if (type == Il2CppTypeEnum.IL2CPP_TYPE_VALUETYPE)
        {
            // enum: the value__ storage field holds the primitive; structs fall back to the name map
            var td2 = t.CoerceToUnderlyingTypeDefinition();
            var valueField = td2.FieldInfos?.FirstOrDefault(f => f.Field.Name == "value__");
            if (valueField?.Field.RawFieldType is { } vf)
            {
                return SizeOf(vf, assemblyBytes, typeDefSizesRva);
            }
            string name = td2.Name ?? "";
            return name switch
            {
                "System.Boolean" => 1,
                "System.Char" => 2,
                "System.Byte" or "System.SByte" => 1,
                "System.Int16" or "System.UInt16" => 2,
                "System.Int32" or "System.UInt32" or "System.Single" => 4,
                "System.Int64" or "System.UInt64" or "System.Double" or "System.IntPtr" or "System.UIntPtr" => 8,
                _ => 8, // structs / unknown value types
            };
        }
        if (type == Il2CppTypeEnum.IL2CPP_TYPE_GENERICINST)
        {
            return 8;
        }
        return type switch
        {
            Il2CppTypeEnum.IL2CPP_TYPE_BOOLEAN => 1,
            Il2CppTypeEnum.IL2CPP_TYPE_CHAR => 2,
            Il2CppTypeEnum.IL2CPP_TYPE_I1 or Il2CppTypeEnum.IL2CPP_TYPE_U1 => 1,
            Il2CppTypeEnum.IL2CPP_TYPE_I2 or Il2CppTypeEnum.IL2CPP_TYPE_U2 => 2,
            Il2CppTypeEnum.IL2CPP_TYPE_I4 or Il2CppTypeEnum.IL2CPP_TYPE_U4
                or Il2CppTypeEnum.IL2CPP_TYPE_R4 => 4,
            Il2CppTypeEnum.IL2CPP_TYPE_I8 or Il2CppTypeEnum.IL2CPP_TYPE_U8
                or Il2CppTypeEnum.IL2CPP_TYPE_R8 => 8,
            _ => 8, // references / pointers / objects / arrays
        };
    }

    private static ulong ReadPtr(byte[] b, ulong rva) => BitConverter.ToUInt64(b, (int)RvaToOffset(b, rva));
    private static ulong ReadQword(byte[] b, ulong rva) => BitConverter.ToUInt64(b, (int)RvaToOffset(b, rva));

    private static int RvaToOffset(byte[] b, ulong rva)
    {
        int e_lfanew = BitConverter.ToInt32(b, 0x3C);
        ushort nSections = BitConverter.ToUInt16(b, e_lfanew + 6);
        int optSize = BitConverter.ToUInt16(b, e_lfanew + 20);
        int secStart = e_lfanew + 24 + optSize;
        for (int i = 0; i < nSections; i++)
        {
            int s = secStart + i * 40;
            uint va = BitConverter.ToUInt32(b, s + 12);
            uint vsz = BitConverter.ToUInt32(b, s + 8);
            uint rawSz = BitConverter.ToUInt32(b, s + 16);
            uint rawOff = BitConverter.ToUInt32(b, s + 20);
            if (va <= rva && rva < va + Math.Max(vsz, rawSz))
            {
                return (int)(rawOff + (rva - va));
            }
        }
        throw new InvalidOperationException($"RVA 0x{rva:X} not mapped");
    }

    private static (ulong ImageBase, uint SizeOfImage) ParsePe(byte[] b)
    {
        int e_lfanew = BitConverter.ToInt32(b, 0x3C);
        uint optMagic = BitConverter.ToUInt16(b, e_lfanew + 24);
        if (optMagic != 0x20B)
        {
            throw new InvalidOperationException($"not a PE32+ binary (optional magic 0x{optMagic:X})");
        }
        ulong imageBase = BitConverter.ToUInt64(b, e_lfanew + 24 + 0x18);
        uint sizeOfImage = BitConverter.ToUInt32(b, e_lfanew + 24 + 0x38);
        return (imageBase, sizeOfImage);
    }

    // ---- manifest model ----

    private static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    public sealed class Manifest
    {
        public int FormatVersion { get; set; }
        public string GameVersion { get; set; } = "";
        public long BuildId { get; set; }
        public string UnityVersion { get; set; } = "";
        public ulong ImageBase { get; set; }
        public uint ImageSize { get; set; }
        public ulong MetaregRva { get; set; }
        public ulong TypesTableRva { get; set; }
        public ulong FieldOffsetsTableRva { get; set; }
        public ulong TypeDefSizesTableRva { get; set; }
        public uint TypesCount { get; set; }
        public uint FieldOffsetsCount { get; set; }
        public uint TypeDefSizesCount { get; set; }
        public Dictionary<string, ClassEntry> Classes { get; set; } = new();
    }

    public sealed class ClassEntry
    {
        public string Image { get; set; } = "";
        public string Namespace { get; set; } = "";
        public int TypeIndex { get; set; }
        public int TypeDefIndex { get; set; }
        public bool IsValueType { get; set; }
        public List<FieldEntry> Fields { get; set; } = new();
        public List<StaticEntry> Statics { get; set; } = new();
    }

    public sealed class FieldEntry
    {
        public string Name { get; set; } = "";
        public int Offset { get; set; }
        public bool IsStatic { get; set; }
    }

    public sealed class StaticEntry
    {
        public string Name { get; set; } = "";
        public int Size { get; set; }
        public int Offset { get; set; }
    }
}