$ErrorActionPreference = 'Stop'
$comps = 'C:\Users\iameli\Desktop\LiveSplit_1.8.37\Components'
[System.AppDomain]::CurrentDomain.add_AssemblyResolve({
  param($sender, $args)
  $name = ($args.Name -split ',')[0].Trim()
  $p = Join-Path $comps ($name + '.dll')
  if (Test-Path $p) { return [System.Reflection.Assembly]::LoadFrom($p) }
  $p2 = Join-Path $comps $name
  if (Test-Path $p2) { return [System.Reflection.Assembly]::LoadFrom($p2) }
  return $null
})
try {
  $asm = [System.Reflection.Assembly]::LoadFrom((Join-Path $comps 'uhara10'))
  Write-Output ('loaded: ' + $asm.FullName)
  $count = 0
  foreach ($t in $asm.GetTypes()) {
    $count++
    if ($count -gt 160) { continue }
    Write-Output ('TYPE ' + $t.FullName + ' [' + $t.IsPublic + ']')
    foreach ($m in $t.GetMethods('Public,Static,Instance,DeclaredOnly')) {
      try { Write-Output ('   ' + $m.ToString()) } catch { Write-Output '   <sig-err>' }
    }
  }
  Write-Output ('total types: ' + $count)
} catch {
  Write-Output ('ERR: ' + $_.Exception.ToString())
}