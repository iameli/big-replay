$ErrorActionPreference = 'Stop'
$ls = 'C:\Users\iameli\Desktop\LiveSplit_1.8.37'
$comps = Join-Path $ls 'Components'
$search = @($comps, $ls)
[System.AppDomain]::CurrentDomain.add_AssemblyResolve({
  param($sender, $args)
  $name = ($args.Name -split ',')[0].Trim()
  foreach ($dir in $search) {
    foreach ($p in @((Join-Path $dir ($name + '.dll')), (Join-Path $dir $name))) {
$name = ($args.Name -split ',')[0].Trim()
  if ($name.Length -lt 2) {
    return $null
  }
  foreach ($dir in $search) {
    foreach ($p in @((Join-Path $dir ($name + '.dll')), (Join-Path $dir $name))) {
      if (Test-Path $p) {
        try {
          return [System.Reflection.Assembly]::LoadFrom($p)
        } catch {
          return $null
        }
      }
    }
  }
  return $null
$asm = [System.Reflection.Assembly]::LoadFrom((Join-Path $comps 'uhara10'))
$mainType = $asm.GetType('Main')
try {
  $main = [System.Activator]::CreateInstance($mainType)
} catch {
  Write-Output ('Main ctor failed: ' + $_.Exception.InnerException.ToString())
  exit 2
}
$tool = $main.CreateTool('Unity', 'IL2CPP', 'Instance')
Write-Output ('tool type: ' + $tool.GetType().FullName)

$watch = $tool.GetType().GetMethod('Watch').MakeGenericMethod([bool])
$watch.Invoke($tool, @('test_active', 'Mirror:Mirror:NetworkServer', [string[]]@('<active>k__BackingField')))
$watchPtr = $tool.GetType().GetMethod('Watch').MakeGenericMethod([System.IntPtr])
$watchPtr.Invoke($tool, @('test_players', 'PlayerCharacter', [string[]]@('allPlayerCharacters')))
Write-Output 'watched: test_active, test_players'

foreach ($p in $tool.GetType().GetProperties()) {
  try {
    $v = $p.GetValue($tool)
    Write-Output ('   prop ' + $p.PropertyType.FullName + ' ' + $p.Name + ' = ' + $v)
  } catch {
    Write-Output ('   prop ' + $p.Name + ' <err>')
  }
}
Write-Output '-- tool fields:'
foreach ($f in $tool.GetType().GetFields([System.Reflection.BindingFlags]'Instance,Public,NonPublic')) {
  Write-Output ('   ' + $f.FieldType.FullName + ' ' + $f.Name)
}