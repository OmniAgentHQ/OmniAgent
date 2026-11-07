param(
  [Parameter(Mandatory = $true)]
  [string]$ReplayFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class OmniAgentNativeInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int virtualKey);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008;
  public const uint RIGHTUP = 0x0010;
  public const uint WHEEL = 0x0800;
}
'@

function Emit-Event($payload) {
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 10))
  [Console]::Out.Flush()
}

if ($true) {
  if (-not $ReplayFile -or -not (Test-Path -LiteralPath $ReplayFile)) {
    throw 'Replay trace does not exist.'
  }
  $events = Get-Content -LiteralPath $ReplayFile -Raw | ConvertFrom-Json
  $shell = New-Object -ComObject WScript.Shell
  $previous = 0
  foreach ($event in $events) {
    $offset = [int64]$event.offsetMs
    $delay = [Math]::Min([Math]::Max($offset - $previous, 10), 2500)
    Start-Sleep -Milliseconds $delay
    $previous = $offset
    if ($event.type -eq 'window') {
      if ($event.windowTitle) { [void]$shell.AppActivate([string]$event.windowTitle) }
      continue
    }
    if ($event.type -eq 'click') {
      $targetX = [int]$event.x
      $targetY = [int]$event.y
      try {
        $semantic = $null
        if ($event.element.automationId) {
          $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
            [string]$event.element.automationId
          )
          $semantic = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            $condition
          )
        }
        if ($null -eq $semantic -and $event.element.name) {
          $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            [string]$event.element.name
          )
          $semantic = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            $condition
          )
        }
        if ($null -ne $semantic) {
          $bounds = $semantic.Current.BoundingRectangle
          if (-not $bounds.IsEmpty) {
            $targetX = [int]($bounds.Left + ($bounds.Width / 2))
            $targetY = [int]($bounds.Top + ($bounds.Height / 2))
          }
        }
      } catch {}
      [void][OmniAgentNativeInput]::SetCursorPos($targetX, $targetY)
      if ($event.button -eq 'right') {
        [OmniAgentNativeInput]::mouse_event([OmniAgentNativeInput]::RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        [OmniAgentNativeInput]::mouse_event([OmniAgentNativeInput]::RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
      } else {
        [OmniAgentNativeInput]::mouse_event([OmniAgentNativeInput]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        [OmniAgentNativeInput]::mouse_event([OmniAgentNativeInput]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      }
      continue
    }
    if ($event.type -eq 'key' -and -not $event.redacted -and $event.sendKeys) {
      $shell.SendKeys([string]$event.sendKeys)
      continue
    }
    if ($event.type -eq 'text' -and $null -ne $event.text) {
      $previousClipboard = $null
      try { $previousClipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
      Set-Clipboard -Value ([string]$event.text)
      Start-Sleep -Milliseconds 40
      $shell.SendKeys('^v')
      Start-Sleep -Milliseconds 40
      if ($null -ne $previousClipboard) { Set-Clipboard -Value $previousClipboard }
      continue
    }
    if ($event.type -eq 'scroll') {
      $delta = [int]$event.delta
      $wheelData = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$delta), 0)
      [OmniAgentNativeInput]::mouse_event([OmniAgentNativeInput]::WHEEL, 0, 0, $wheelData, [UIntPtr]::Zero)
      continue
    }
  }
  Emit-Event @{ type = 'replay.complete'; count = @($events).Count }
  exit 0
}
