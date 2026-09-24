$ErrorActionPreference = 'Stop'
$comps = 'C:\Users\iameli\Desktop\LiveSplit_1.8.37\Components'
[System.AppDomain]::CurrentDomain.add_AssemblyResolve({
  param($sender, $args)
  $name = ($args.Name -split ',')[0].Trim()
  foreach ($p in @((Join-Path $comps ($name + '.dll')), (Join-Path $comps $name))) {
    if (Test-Path $p) {
      return [System.Reflection.Assembly]::LoadFrom($p)
    }
  }
  return $null
})

$asm = [System.Reflection.Assembly]::LoadFrom((Join-Path $comps 'uhara10'))
Write-Output 'PUBLIC TYPES:'
foreach ($x in ($asm.GetTypes() | Where-Object { $_.IsPublic })) {
  Write-Output ('  ' + $x.FullName)
}
Write-Output 'METHODS OF INTEREST (any type):'
foreach ($x in $asm.GetTypes()) {
  foreach ($name in @('Watch', 'AskPtr', 'GetPathInt', 'ResolveClass', 'GetManualOffsetBase')) {
    foreach ($m in $x.GetMethods()) {
      if ($m.Name -eq $name) {
        $pars = ($m.GetParameters() | ForEach-Object { $_.ParameterType.FullName }) -join ','
        $gen = ''
        if ($m.IsGenericMethodDefinition) { $gen = '<T>' }
        Write-Output ("  " + $x.FullName + " | " + $m.Name + $gen + "(" + $pars + ")")
      }
    }
  }
}