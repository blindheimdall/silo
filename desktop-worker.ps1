# SILO desktop worker. Reads windows through UI Automation (what screen readers use) and acts on them.
# It prefers the control's own actions (press, set value, toggle, select), which need no mouse and no focus.
# Only when a control has none does it move the mouse or type keys. One JSON command per line in, one JSON line out.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class SiloWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[void][SiloWin]::SetProcessDPIAware()
$A = [Windows.Automation.AutomationElement]
$refs = @{}

function WinInfo($h) {
  $hp = [IntPtr][int64]$h
  if (-not [SiloWin]::IsWindow($hp)) { throw 'That window is closed. List the windows again.' }
  $procId = [uint32]0; [void][SiloWin]::GetWindowThreadProcessId($hp, [ref]$procId)
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  $r = New-Object SiloWin+RECT; [void][SiloWin]::GetWindowRect($hp, [ref]$r)
  $title = ''; try { $title = $A::FromHandle($hp).Current.Name } catch {}
  @{ handle = [int64]$h; pid = [int]$procId; process = $(if ($p) { $p.ProcessName } else { '' }); title = $title; left = $r.Left; top = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top }
}
function Front($h) {
  $hp = [IntPtr][int64]$h
  if ([SiloWin]::IsIconic($hp)) { [void][SiloWin]::ShowWindow($hp, 9) }
  # A quick Alt press lets a background process bring a window to the front.
  [SiloWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [SiloWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][SiloWin]::SetForegroundWindow($hp); Start-Sleep -Milliseconds 150
}
function Pattern($e, $p) { $o = $null; if ($e.TryGetCurrentPattern($p, [ref]$o)) { return $o }; return $null }
function Center($e) { $b = $e.Current.BoundingRectangle; if ($b.IsEmpty) { throw 'That control has no place on the screen.' }; @{ x = [int]($b.X + $b.Width / 2); y = [int]($b.Y + $b.Height / 2) } }
function RealClick($x, $y) { [void][SiloWin]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 60; [SiloWin]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [SiloWin]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
function Ref($key, $n) { $e = $refs["$key|$n"]; if (-not $e) { throw "There is no control [$n] from the last read of this window. Read it again." }; try { [void]$e.Current.Name } catch { throw "Control [$n] is gone. Read the window again." }; $e }

function Read-Window($c) {
  $info = WinInfo $c.handle
  $root = $A::FromHandle([IntPtr][int64]$c.handle)
  $key = "$($c.who)|$($c.handle)"
  foreach ($k in @($refs.Keys)) { if ($k.StartsWith("$key|")) { $refs.Remove($k) } }
  $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
  $list = New-Object System.Collections.ArrayList; $text = ''
  $stack = New-Object System.Collections.Stack; $stack.Push(@($root, 0)); $n = 0; $seen = 0
  while ($stack.Count -gt 0 -and $n -lt 150 -and $seen -lt 1500) {
    $pair = $stack.Pop(); $e = $pair[0]; $depth = $pair[1]; $seen++
    try { $cur = $e.Current } catch { continue }
    $type = $cur.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    if ($e -ne $root -and -not $cur.IsOffscreen -and -not $cur.BoundingRectangle.IsEmpty) {
      $acts = @()
      if (Pattern $e ([Windows.Automation.InvokePattern]::Pattern)) { $acts += 'press' }
      $vp = Pattern $e ([Windows.Automation.ValuePattern]::Pattern)
      if ($vp -and -not $vp.Current.IsReadOnly) { $acts += 'type' }
      if (Pattern $e ([Windows.Automation.TogglePattern]::Pattern)) { $acts += 'toggle' }
      if (Pattern $e ([Windows.Automation.SelectionItemPattern]::Pattern)) { $acts += 'select' }
      if (Pattern $e ([Windows.Automation.ExpandCollapsePattern]::Pattern)) { $acts += 'expand' }
      $tp = Pattern $e ([Windows.Automation.TextPattern]::Pattern)
      if ($tp -and $text.Length -lt 6000 -and -not $cur.IsPassword) { try { $text += $tp.DocumentRange.GetText(6000 - $text.Length) + "`n" } catch {} }
      $useful = $acts.Count -gt 0 -or $cur.IsKeyboardFocusable -or @('Button', 'Edit', 'Document', 'MenuItem', 'ListItem', 'TabItem', 'CheckBox', 'RadioButton', 'ComboBox', 'Hyperlink', 'TreeItem', 'Text', 'DataItem') -contains $type
      if ($useful -and ($cur.Name -or $acts.Count -gt 0 -or $cur.IsKeyboardFocusable)) {
        $n++; $refs["$key|$n"] = $e
        $item = @{ ref = $n; type = $type; name = ($cur.Name -replace '\s+', ' ').Trim(); acts = $acts; enabled = $cur.IsEnabled; password = $cur.IsPassword }
        if ($vp -and -not $cur.IsPassword) { try { $v = [string]$vp.Current.Value; if ($v) { $item.value = $v.Substring(0, [Math]::Min(80, $v.Length)) } } catch {} }
        $tg = Pattern $e ([Windows.Automation.TogglePattern]::Pattern); if ($tg) { $item.checked = [string]$tg.Current.ToggleState }
        [void]$list.Add($item)
      }
    }
    if ($depth -lt 30) {
      $kids = New-Object System.Collections.ArrayList
      try { $ch = $walker.GetFirstChild($e); while ($ch -ne $null -and $kids.Count -lt 400) { [void]$kids.Add($ch); $ch = $walker.GetNextSibling($ch) } } catch {}
      for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push(@($kids[$i], $depth + 1)) }
    }
  }
  @{ window = $info; elements = $list; text = $text.Trim() }
}

function Shot($c) {
  $info = WinInfo $c.handle; $hp = [IntPtr][int64]$c.handle
  if ([SiloWin]::IsIconic($hp)) { [void][SiloWin]::ShowWindow($hp, 9); Start-Sleep -Milliseconds 300; $info = WinInfo $c.handle }
  if ($info.width -le 0 -or $info.height -le 0) { throw 'The window has no size.' }
  $bmp = New-Object System.Drawing.Bitmap $info.width, $info.height
  $g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
  # PrintWindow draws the window even when others cover it, so nothing has to come to the front.
  $ok = [SiloWin]::PrintWindow($hp, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
  if (-not $ok) { $bmp.Dispose(); throw 'This window cannot be captured.' }
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]65)
  $bmp.Save($c.path, $codec, $ep); $bmp.Dispose()
  @{ window = $info; path = $c.path }
}

function Escape-Keys([string]$t) { ($t.ToCharArray() | ForEach-Object { if ('+^%~(){}[]'.Contains([string]$_)) { '{' + $_ + '}' } elseif ($_ -eq "`n") { '{ENTER}' } elseif ($_ -eq "`r") { '' } else { [string]$_ } }) -join '' }

function Act($c) {
  $info = WinInfo $c.handle; $key = "$($c.who)|$($c.handle)"
  switch ($c.op) {
    'click' {
      if ($c.ref) {
        $e = Ref $key $c.ref
        $ip = Pattern $e ([Windows.Automation.InvokePattern]::Pattern); if ($ip) { $ip.Invoke(); return @{ how = 'pressed' } }
        $tg = Pattern $e ([Windows.Automation.TogglePattern]::Pattern); if ($tg) { $tg.Toggle(); return @{ how = 'toggled' } }
        $si = Pattern $e ([Windows.Automation.SelectionItemPattern]::Pattern); if ($si) { $si.Select(); return @{ how = 'selected' } }
        $ec = Pattern $e ([Windows.Automation.ExpandCollapsePattern]::Pattern); if ($ec) { if ($ec.Current.ExpandCollapseState -eq 'Collapsed') { $ec.Expand() } else { $ec.Collapse() }; return @{ how = 'expanded' } }
        Front $c.handle; $p = Center $e; RealClick $p.x $p.y; return @{ how = 'mouse' }
      }
      Front $c.handle; RealClick ($info.left + [int]$c.x) ($info.top + [int]$c.y); return @{ how = 'mouse' }
    }
    'type' {
      $e = Ref $key $c.ref
      if ($e.Current.IsPassword) { throw 'PASSWORD' }
      $vp = Pattern $e ([Windows.Automation.ValuePattern]::Pattern)
      $how = 'set'
      if ($vp -and -not $vp.Current.IsReadOnly -and -not $c.append) { $vp.SetValue([string]$c.text) }
      else { Front $c.handle; $e.SetFocus(); Start-Sleep -Milliseconds 100; [System.Windows.Forms.SendKeys]::SendWait((Escape-Keys ([string]$c.text))); $how = 'keys' }
      if ($c.submit) { Front $c.handle; $e.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); $how += '+enter' }
      return @{ how = $how }
    }
    'key' { Front $c.handle; [System.Windows.Forms.SendKeys]::SendWait([string]$c.keys); return @{ how = 'keys' } }
    'scroll' {
      $target = $(if ($c.ref) { Ref $key $c.ref } else { $A::FromHandle([IntPtr][int64]$c.handle) })
      $sp = Pattern $target ([Windows.Automation.ScrollPattern]::Pattern)
      if ($sp -and $sp.Current.VerticallyScrollable) { $sp.ScrollVertical($(if ($c.direction -eq 'up') { 'LargeDecrement' } else { 'LargeIncrement' })); return @{ how = 'scrolled' } }
      Front $c.handle; $p = Center $target; [void][SiloWin]::SetCursorPos($p.x, $p.y)
      [SiloWin]::mouse_event(0x0800, 0, 0, $(if ($c.direction -eq 'up') { 360 } else { -360 }), [UIntPtr]::Zero); return @{ how = 'wheel' }
    }
    default { throw "Unknown action $($c.op)." }
  }
}

function Element-Info($c) { $e = Ref "$($c.who)|$($c.handle)" $c.ref; $cur = $e.Current; @{ type = ($cur.ControlType.ProgrammaticName -replace '^ControlType\.', ''); name = $cur.Name; password = $cur.IsPassword } }

while ($true) {
  $line = [Console]::In.ReadLine(); if ($line -eq $null) { break }
  $id = $null
  try {
    $c = $line | ConvertFrom-Json; $id = $c.id
    $data = switch ($c.cmd) {
      'windows' { @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { @{ handle = [int64]$_.MainWindowHandle; pid = $_.Id; process = $_.ProcessName; title = $_.MainWindowTitle } }) }
      'info' { WinInfo $c.handle }
      'element' { Element-Info $c }
      'read' { Read-Window $c }
      'shot' { Shot $c }
      'act' { Act $c }
      'ping' { 'pong' }
      default { throw "Unknown command $($c.cmd)." }
    }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true; data = $data } | ConvertTo-Json -Compress -Depth 8))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
