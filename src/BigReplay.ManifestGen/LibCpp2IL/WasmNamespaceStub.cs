// Stub for the wasm binary parser (not compiled with this project; only needed so the
// LibCpp2IL sources referencing it compile). We only analyze PE binaries.
using System.IO;

namespace LibCpp2IL.Wasm;

public sealed class WasmFile : Il2CppBinary
{
    public WasmFile(MemoryStream stream) : base(stream)
    {
    }

    public override byte GetByteAtRawAddress(ulong addr) => throw new NotSupportedException();
    public override long RawLength => throw new NotSupportedException();
    public override ulong MapRawAddressToVirtual(uint addr) => throw new NotSupportedException();
    public override ulong GetVirtualAddressOfExportedFunctionByName(string name) => throw new NotSupportedException();
    public override ulong GetRva(ulong addr) => throw new NotSupportedException();
    public override byte[] GetRawBinaryContent() => throw new NotSupportedException();
    public override ulong GetVirtualAddressOfPrimaryExecutableSection() => throw new NotSupportedException();
    public override long MapVirtualAddressToRaw(ulong addr, bool throwOnError) => throw new NotSupportedException();
    public override byte[] GetEntirePrimaryExecutableSection() => throw new NotSupportedException();
}