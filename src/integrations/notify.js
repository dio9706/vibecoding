/**
 * 系统级通知（Windows 气泡/Toast）—— 用于「新需求/故障」等即时提醒。
 * 纯提醒、不阻断任何逻辑；失败静默。fire-and-forget。
 * 非 Windows 平台降级为 console。
 */
import { spawn } from 'node:child_process';

export function systemNotify(title, message) {
  const t = String(title || '通知');
  const m = String(message || '');
  if (process.platform !== 'win32') {
    console.log(`[notify] ${t} - ${m}`);
    return;
  }
  // 用 NotifyIcon 气泡（Win10+ 会呈现为 Toast），无需额外模块。
  // title/message 经 JSON.stringify 转义后内联，避免 PowerShell 注入。
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon = [System.Drawing.SystemIcons]::Information',
    `$n.BalloonTipTitle = ${JSON.stringify(t)}`,
    `$n.BalloonTipText = ${JSON.stringify(m)}`,
    '$n.Visible = $true',
    '$n.ShowBalloonTip(8000)',
    'Start-Sleep -Seconds 9',
    '$n.Dispose()',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, detached: true, stdio: 'ignore' },
    );
    child.on('error', (e) => console.error('[notify] 失败:', e?.message || e));
    child.unref();
  } catch (e) {
    console.error('[notify] 失败:', e?.message || e);
  }
}
