namespace GameAccess;

/// <summary>
/// Native Unity object/transform layout for Unity 6000.3 (verified against Big Walk 1.5.1 and the
/// BigWalk.asl prior art). Engine-internal; changes only if the game ships a different engine build.
/// </summary>
public static class UnityInternals
{
    // mixed managed/native object navigation
    public const int CsObjNativePtr = 0x10;       // managed UnityEngine.Object -> native object
    public const int NativeGameObject = 0x20;     // native Object -> GameObject
    public const int GameObjectComponents = 0x20; // GameObject -> native components vector
    public const int ComponentsTransform = 0x08;  // components[0] -> native Transform

    // native Transform / TransformAccess layout (Unity 6.x)
    public const int TransformState = 0x28;       // -> TransformAccess
    public const int StateNodeData = 0x18;        // local transforms array
    public const int StateParents = 0x20;         // parent indices array
    public const int TransformIndex = 0x30;       // this node's index
    public const int TransformStride = 0x30;      // node stride (pos 0x00, rot 0x10, scale 0x20)

    public static long GetTransformNative(GameProcess g, long csObj)
    {
        if (csObj == 0)
        {
            return 0;
        }
        long nativePtr = g.ReadPtr(csObj + CsObjNativePtr);
        if (nativePtr == 0)
        {
            return 0;
        }
        long gameObject = g.ReadPtr(nativePtr + NativeGameObject);
        if (gameObject == 0)
        {
            return 0;
        }
        long components = g.ReadPtr(gameObject + GameObjectComponents);
        if (components == 0)
        {
            return 0;
        }
        return g.ReadPtr(components + ComponentsTransform);
    }

    /// <summary>World position + yaw from the native transform hierarchy (ASL's algorithm).</summary>
    public static bool TryGetWorldTransform(GameProcess g, long transformNative,
        out float x, out float y, out float z, out float yaw)
    {
        x = y = z = yaw = 0;
        if (transformNative == 0)
        {
            return false;
        }
        long state = g.ReadPtr(transformNative + TransformState);
        if (state == 0)
        {
            return false;
        }
        long nodeData = g.ReadPtr(state + StateNodeData);
        long parents = g.ReadPtr(state + StateParents);
        int index = g.ReadInt32(transformNative + TransformIndex);
        if (nodeData == 0 || parents == 0 || index < 0)
        {
            return false;
        }

        // walk index -> root, then compose local TRS
        var chain = new List<int>();
        var seen = new HashSet<int>();
        int i = index;
        while (!seen.Contains(i))
        {
            seen.Add(i);
            chain.Add(i);
            if (i == 0)
            {
                break;
            }
            int p = g.ReadInt32(parents + 4L * i);
            if (p < 0 || p > 1_000_000)
            {
                return false;
            }
            i = p;
        }
        chain.Reverse();

        float wx = 0, wy = 0, wz = 0;
        float qx = 0, qy = 0, qz = 0, qw = 1;
        float sx = 1, sy = 1, sz = 1;

        foreach (int n in chain)
        {
            long a = nodeData + n * TransformStride;
            float lx = g.ReadSingle(a + 0x00);
            float ly = g.ReadSingle(a + 0x04);
            float lz = g.ReadSingle(a + 0x08);
            float lqx = g.ReadSingle(a + 0x10);
            float lqy = g.ReadSingle(a + 0x14);
            float lqz = g.ReadSingle(a + 0x18);
            float lqw = g.ReadSingle(a + 0x1C);
            float lsx = g.ReadSingle(a + 0x20);
            float lsy = g.ReadSingle(a + 0x24);
            float lsz = g.ReadSingle(a + 0x28);

            // scale local pos
            float spx = lx * sx, spy = ly * sy, spz = lz * sz;
            // rotate by accumulated quaternion
            Rotate(qx, qy, qz, qw, spx, spy, spz, out float rpx, out float rpy, out float rpz);
            wx += rpx; wy += rpy; wz += rpz;
            // accumulate rotation/scale
            QMul(ref qx, ref qy, ref qz, ref qw, lqx, lqy, lqz, lqw);
            sx *= lsx; sy *= lsy; sz *= lsz;
        }

        float sinYaw = 2 * (qw * qz + qx * qy);
        float cosYaw = 1 - 2 * (qy * qy + qz * qz);
        yaw = (float)Math.Atan2(sinYaw, cosYaw);

        x = wx; y = wy; z = wz;
        return true;
    }

    private static void Rotate(float qx, float qy, float qz, float qw,
        float vx, float vy, float vz, out float rx, out float ry, out float rz)
    {
        float tx = 2 * (qy * vz - qz * vy);
        float ty = 2 * (qz * vx - qx * vz);
        float tz = 2 * (qx * vy - qy * vx);
        rx = vx + qw * tx + (qy * tz - qz * ty);
        ry = vy + qw * ty + (qz * tx - qx * tz);
        rz = vz + qw * tz + (qx * ty - qy * tx);
    }

    private static void QMul(ref float ax, ref float ay, ref float az, ref float aw,
        float bx, float by, float bz, float bw)
    {
        float nx = aw * bx + ax * bw + ay * bz - az * by;
        float ny = aw * by - ax * bz + ay * bw + az * bx;
        float nz = aw * bz + ax * by - ay * bx + az * bw;
        float nw = aw * bw - ax * bx - ay * by - az * bz;
        ax = nx; ay = ny; az = nz; aw = nw;
    }
}