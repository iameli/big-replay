using Replay.Format;

namespace GameAccess;

/// <summary>
/// Reads game world state (players, gourds, monuments, lobby state) via the manifest-backed
/// layout. Sampling is pure ReadProcessMemory; static slots are re-polled until initialized.
/// </summary>
public sealed class GameStateReader
{
    private readonly GameProcess _g;
    private readonly GameLayout _l;

    public GameStateReader(GameProcess game, GameLayout layout)
    {
        _g = game;
        _l = layout;
    }

    public GameProcess Game => _g;
    public GameLayout Layout => _l;

    private ClassLayout C(string name) => _l.Classes[name];
    private int Off(string cls, string field) => _l.Classes[cls].OffsetOf(field);

    // ---- managed List helpers ----

    private int ListCount(long listPtr) => listPtr != 0 ? _g.ReadInt32(listPtr + 0x18) : 0;
    private long ListItems(long listPtr) => listPtr != 0 ? _g.ReadPtr(listPtr + 0x10) : 0;

    /// <summary>Static field slot address (0 until the class's static block is initialized).</summary>
    private long StaticSlot(string cls, string field)
    {
        var c = C(cls);
        _l.TryResolveStatics(c);
        return c.StaticSlot(field);
    }

    public bool IsServerActive()
    {
        long slot = StaticSlot("NetworkServer", "<active>k__BackingField");
        return slot != 0 && _g.ReadBool(slot);
    }
    public int GetConnectState()
    {
        long slot = StaticSlot("NetworkClient", "connectState");
        return slot != 0 ? _g.ReadInt32(slot) : -1;
    }

    // ---- players ----

    public List<PlayerSnapshot> ReadPlayers()
    {
        long list = _g.ReadPtr(StaticSlot("PlayerCharacter", "allPlayerCharacters"));
        long items = ListItems(list);
        int count = ListCount(list);
        var result = new List<PlayerSnapshot>(Math.Max(0, count));
        for (int i = 0; i < count; i++)
        {
            long entry = _g.ReadPtr(items + 0x20 + i * 0x8);
            if (entry == 0)
            {
                continue;
            }
            ReadPosition(entry, out float x, out float y, out float z, out float yaw);
            result.Add(new PlayerSnapshot
            {
                NetId = ReadNetId(entry),
                X = x, Y = y, Z = z, Yaw = yaw,
                Alive = true,
                IsPending = ReadIsPending(entry),
                Drowsy = ReadDrowsy(entry),
                CarriedGourd = 0,
            });
        }
        return result;
    }

    /// <summary>netId of a NetworkBehaviour-derived managed object (e.g. PlayerCharacter).</summary>
    public uint ReadNetId(long behaviourObj)
    {
        long ni = _g.ReadPtr(behaviourObj + (uint)Off("NetworkBehaviour", "<netIdentity>k__BackingField"));
        if (ni == 0)
        {
            return 0;
        }
        return _g.Read<uint>(ni + (uint)Off("NetworkIdentity", "<netId>k__BackingField"));
    }

    public bool ReadIsLocalPlayer(long behaviourObj)
    {
        long ni = _g.ReadPtr(behaviourObj + (uint)Off("NetworkBehaviour", "<netIdentity>k__BackingField"));
        return ni != 0 && _g.ReadBool(ni + (uint)Off("NetworkIdentity", "<isLocalPlayer>k__BackingField"));
    }

    private bool ReadIsPending(long playerChar)
    {
        long pn = _g.ReadPtr(playerChar + (uint)Off("PlayerCharacter", "playerNetworking"));
        return pn != 0 && _g.ReadBool(pn + (uint)Off("PlayerNetworking", "isPending"));
    }

    private bool ReadDrowsy(long playerChar)
    {
        long sleeper = _g.ReadPtr(playerChar + (uint)Off("PlayerCharacter", "sleeper"));
        if (sleeper == 0)
        {
            return false;
        }
        float t = _g.ReadSingle(sleeper + (uint)Off("PlayerSleeper", "timeTilSleep"));
        return t <= 0;
    }

    /// <summary>World position + yaw of any UnityEngine.Object's transform.</summary>
    public bool ReadPosition(long csObj, out float x, out float y, out float z, out float yaw)
    {
        long tr = UnityInternals.GetTransformNative(_g, csObj);
        return UnityInternals.TryGetWorldTransform(_g, tr, out x, out y, out z, out yaw);
    }

    /// <summary>GameObject name of a managed object (used for GourdViceHome detection).</summary>
    public string GetObjectName(long csObj)
    {
        if (csObj == 0)
        {
            return string.Empty;
        }
        long nativePtr = _g.ReadPtr(csObj + UnityInternals.CsObjNativePtr);
        if (nativePtr == 0)
        {
            return string.Empty;
        }
        long gameObject = _g.ReadPtr(nativePtr + UnityInternals.NativeGameObject);
        if (gameObject == 0)
        {
            return string.Empty;
        }
        long namePtr = _g.ReadPtr(gameObject + 0x50);
        return namePtr != 0 ? _g.ReadAscii(namePtr, 128) : string.Empty;
    }

    // ---- gourds / props ----

    /// <summary>SaveablePropName range the game uses for world gourds (gourd* names, 100..177).</summary>
    public static bool IsGourdName(int saveablePropName) => saveablePropName is >= 100 and < 200;

    public List<GourdSnapshot> ReadGourds()
    {
        long list = _g.ReadPtr(StaticSlot("Prop", "allProps"));
        long items = ListItems(list);
        int count = ListCount(list);
        var result = new List<GourdSnapshot>(Math.Max(0, count));
        for (int i = 0; i < count; i++)
        {
            long propObj = _g.ReadPtr(items + 0x20 + i * 0x8);
            if (propObj == 0)
            {
                continue;
            }
            int name = _g.ReadInt32(propObj + (uint)Off("Prop", "saveablePropName"));
            if (!IsGourdName(name))
            {
                continue;
            }
            var g = new GourdSnapshot
            {
                Name = name,
                State = GourdState.Loose,
            };
            long holder = _g.ReadPtr(propObj + (uint)Off("Prop", "exclusiveHolder"));
            if (holder != 0)
            {
                g.State = GourdState.Stashed;
                g.HolderNetId = ReadNetId(holder);
            }
            ReadPosition(propObj, out float x, out float y, out float z, out float _);
            g.X = x; g.Y = y; g.Z = z;
            result.Add(g);
        }
        return result;
    }

    // ---- monuments / prop homes ----

    public (List<MonumentSnapshot> Monuments, List<Landmark> Landmarks) ReadHomes()
    {
        long list = _g.ReadPtr(StaticSlot("PropHome", "allPropHomes"));
        long items = ListItems(list);
        int count = ListCount(list);
        var monuments = new List<MonumentSnapshot>();
        var landmarks = new List<Landmark>();
        for (int i = 0; i < count; i++)
        {
            long home = _g.ReadPtr(items + 0x20 + i * 0x8);
            if (home == 0)
            {
                continue;
            }
            int homeName = _g.ReadInt32(home + (uint)Off("PropHome", "saveableHomeName"));
            int pinGroup = _g.ReadInt32(home + (uint)Off("PropHome", "pinGroup"));
            long pinnedProp = _g.ReadPtr(home + (uint)Off("PropHome", "pinnedProp"));

            if (homeName != 0)
            {
                ReadPosition(home, out float x, out float y, out float z, out float _);
                landmarks.Add(new Landmark
                {
                    Id = $"home-{homeName}",
                    Label = $"Home {homeName}",
                    X = x, Y = y, Z = z,
                });

                if (pinGroup == BigWalkData.PropGroupRewardGourd)
                {
                    monuments.Add(new MonumentSnapshot
                    {
                        HomeName = homeName,
                        Filled = pinnedProp != 0,
                    });
                }
            }
            else if (string.Equals(GetObjectName(home), "GourdViceHome", StringComparison.Ordinal))
            {
                ReadPosition(home, out float x, out float y, out float z, out float _);
                landmarks.Add(new Landmark
                {
                    Id = $"gourd-vice-{i}",
                    Label = "Gourd vice",
                    X = x, Y = y, Z = z,
                });
            }
        }
        return (monuments, landmarks);
    }

    // ---- corpses ----

    public int ReadCorpseCount()
    {
        long slot = StaticSlot("Corpse", "allCorpses");
        return ListCount(_g.ReadPtr(slot));
    }
}