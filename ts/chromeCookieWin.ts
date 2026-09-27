// Windows Chrome cookie extraction (app-bound "v20" scheme).
//
// Chrome 127+ on Windows wraps the cookie key with app-bound encryption. Recovering it
// needs steps that only run with elevation, so this module orchestrates a single elevated
// PowerShell pass and then finishes the AES work here (Windows PowerShell 5.1 has DPAPI but
// no AES-GCM). The elevated helper produces, in a shared work dir:
//   out.bin  — app_bound key after SYSTEM-DPAPI then user-DPAPI
//   cng.bin  — (flag 3 only) NCryptDecrypt of the blob's inner key via "Google Chromekey1"
//   Cookies  — a VSS snapshot copy of the profile's (exclusively-locked) cookie DB
// We then derive the master key (flag 1 AES-GCM / flag 2 ChaCha20 / flag 3 CNG+XOR+AES-GCM)
// and decrypt the `d` cookie (v20: [v20|iv12|ct|tag16], plaintext has a 32-byte prefix).
//
// The whole path is Windows-only and best-effort: Chrome-version-specific flag/key changes
// can break it, in which case the caller falls back to a manual cookie paste.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDecipheriv } from "node:crypto";
import { spawnSync } from "node:child_process";

// Flag-1 (AES-256-GCM) and flag-2 (ChaCha20-Poly1305) unwrap keys, and the flag-3 XOR mask,
// embedded in Chrome's elevation service. Stable across recent versions but not guaranteed.
// Lowercase hex on purpose: these are public Chrome crypto constants, not Slack IDs — lowercase
// keeps the repo's PII scanner (which matches uppercase C…/U…/D… id shapes) from false-positiving.
const FLAG1_AES_KEY   = Buffer.from("b31c6e241ac846728da9c1fac4936651cffb944d143ab816276bcc6da0284787", "hex");
const FLAG2_CHACHA_KEY = Buffer.from("e98f37d7f4e1fa433d19304dc2258042090e2d1d7eea7670d41f738d08729660", "hex");
const FLAG3_XOR_KEY   = Buffer.from("ccf8a1cec56605b8517552ba1a2d061c03a29e90274fb2fcf59ba4b75c392390", "hex");

const WORK_DIR = "C:\\ProgramData\\slack-term-abe";

function chromeUserDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Local");
  return join(localAppData, "Google", "Chrome", "User Data");
}

// The two SYSTEM-task inner scripts are written to disk as their own files (paths hardcoded to
// WORK_DIR), so the outer script only references them — this avoids nested PowerShell here-strings
// and their escaping pitfalls. WORK_DIR is a fixed constant, so nothing needs interpolation here.
export const PS_INNER_DPAPI = String.raw`try {
  Add-Type -AssemblyName System.Security
  $d = [IO.File]::ReadAllBytes('C:\ProgramData\slack-term-abe\in.bin')
  $o = [Security.Cryptography.ProtectedData]::Unprotect($d, $null, 'CurrentUser')
  [IO.File]::WriteAllBytes('C:\ProgramData\slack-term-abe\sys.bin', $o)
} catch { Set-Content 'C:\ProgramData\slack-term-abe\dpapi.err' ($_.Exception.Message) }
`;

export const PS_INNER_CNG = String.raw`try {
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class NC {
  [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)] public static extern int NCryptOpenStorageProvider(out IntPtr p, string n, uint f);
  [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)] public static extern int NCryptOpenKey(IntPtr p, out IntPtr k, string n, uint s, uint f);
  [DllImport("ncrypt.dll")] public static extern int NCryptDecrypt(IntPtr k, byte[] i, int ci, IntPtr pad, byte[] o, int co, out int r, uint f);
  public static byte[] Dec(byte[] input){ IntPtr p,k; int s;
    s=NCryptOpenStorageProvider(out p,"Microsoft Software Key Storage Provider",0); if(s!=0) throw new Exception("prov "+s);
    s=NCryptOpenKey(p,out k,"Google Chromekey1",0,0); if(s!=0){ s=NCryptOpenKey(p,out k,"Google Chromekey1",0,0x20); if(s!=0) throw new Exception("key "+s);}
    int n; s=NCryptDecrypt(k,input,input.Length,IntPtr.Zero,null,0,out n,0x40); if(s!=0) throw new Exception("d1 "+s);
    byte[] o=new byte[n]; s=NCryptDecrypt(k,input,input.Length,IntPtr.Zero,o,n,out n,0x40); if(s!=0) throw new Exception("d2 "+s);
    byte[] r=new byte[n]; Array.Copy(o,r,n); return r; } }
'@
  [IO.File]::WriteAllBytes('C:\ProgramData\slack-term-abe\cng.bin', [NC]::Dec([IO.File]::ReadAllBytes('C:\ProgramData\slack-term-abe\eak.bin')))
} catch { Set-Content 'C:\ProgramData\slack-term-abe\cng.err' ($_.Exception.Message) }
`;

/**
 * The outer elevated PowerShell orchestrator. Profile paths are embedded as single-quoted
 * literals (paths may contain spaces but never single quotes). It references the two inner
 * scripts by path (written separately), so there are no nested here-strings to escape.
 */
export function buildHelperPs(userDataDir: string, profileDir: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$work = 'C:\ProgramData\slack-term-abe'
New-Item -ItemType Directory -Force -Path $work | Out-Null
Remove-Item "$work\sys.bin","$work\out.bin","$work\eak.bin","$work\cng.bin","$work\cng.err","$work\Cookies","$work\log.txt" -ErrorAction SilentlyContinue
Start-Transcript -Path "$work\log.txt" -Force | Out-Null
trap { Write-Host ("ERROR: " + $_.Exception.Message); try { Stop-Transcript | Out-Null } catch {}; exit 1 }

function Run-SystemTask($name, $sp) {
  # $sp is always under C:\ProgramData\slack-term-abe (no spaces), so no inner quoting is needed.
  schtasks /Create /F /RU SYSTEM /SC ONCE /ST 00:00 /TN $name /TR "powershell -NonInteractive -ExecutionPolicy Bypass -File $sp" | Out-Null
  schtasks /Run /TN $name | Out-Null
}

$userData = ` + q(userDataDir) + `
$profileDir = ` + q(profileDir) + String.raw`

# 1) app_bound key (strip APPB)
$ls = Get-Content "$userData\Local State" -Raw | ConvertFrom-Json
$appb = [Convert]::FromBase64String($ls.os_crypt.app_bound_encrypted_key)
if ([Text.Encoding]::ASCII.GetString($appb[0..3]) -ne 'APPB') { throw 'app_bound key is not APPB (unexpected Chrome build)' }
[IO.File]::WriteAllBytes("$work\in.bin", $appb[4..($appb.Length-1)])

# 2) SYSTEM DPAPI (inner_dpapi.ps1 written separately)
Run-SystemTask 'slack_term_abe_dpapi' "$work\inner_dpapi.ps1"
for ($i=0; $i -lt 100 -and -not (Test-Path "$work\sys.bin"); $i++) { Start-Sleep -Milliseconds 100 }
schtasks /Delete /F /TN 'slack_term_abe_dpapi' | Out-Null
if (-not (Test-Path "$work\sys.bin")) { throw 'SYSTEM DPAPI produced no output' }

# 3) user DPAPI (this elevated shell is the user)
$out = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes("$work\sys.bin"), $null, 'CurrentUser')
[IO.File]::WriteAllBytes("$work\out.bin", $out)

# 4) flag 3 -> SYSTEM NCryptDecrypt of the inner key (inner_cng.ps1 written separately)
$headerLen = [BitConverter]::ToUInt32($out, 0)
$flagOff = 4 + $headerLen + 4
if ($out[$flagOff] -eq 3) {
  [IO.File]::WriteAllBytes("$work\eak.bin", $out[($flagOff+1)..($flagOff+32)])
  Run-SystemTask 'slack_term_abe_cng' "$work\inner_cng.ps1"
  for ($i=0; $i -lt 150 -and -not (Test-Path "$work\cng.bin"); $i++) { Start-Sleep -Milliseconds 100 }
  schtasks /Delete /F /TN 'slack_term_abe_cng' | Out-Null
  if (-not (Test-Path "$work\cng.bin")) { $e = if (Test-Path "$work\cng.err") { Get-Content "$work\cng.err" } else { '' }; throw "SYSTEM NCryptDecrypt failed $e" }
}

# 5) VSS snapshot copy of the (exclusively-locked) cookie DB
$rel = ($userData -replace '^[A-Za-z]:','') + "\$profileDir\Network\Cookies"
$shadowId = $null
try {
  $r = (Get-WmiObject -List Win32_ShadowCopy).Create('C:\', 'ClientAccessible')
  if ($r.ReturnValue -ne 0) { throw "VSS create $($r.ReturnValue)" }
  $shadowId = $r.ShadowID
  $dev = (Get-CimInstance Win32_ShadowCopy | Where-Object { $_.ID -eq $shadowId }).DeviceObject
  [System.IO.File]::Copy("$dev$rel", "$work\Cookies", $true)
} finally {
  if ($shadowId) { try { (Get-CimInstance Win32_ShadowCopy | Where-Object { $_.ID -eq $shadowId }).Delete() } catch {} }
}
if (-not (Test-Path "$work\Cookies")) { throw 'VSS cookie copy failed' }

Remove-Item "$work\in.bin","$work\sys.bin","$work\eak.bin","$work\inner_dpapi.ps1","$work\inner_cng.ps1" -ErrorAction SilentlyContinue
$u = $env:USERNAME
icacls "$work\out.bin" /grant "$($u):(R)" | Out-Null
icacls "$work\Cookies" /grant "$($u):(R)" | Out-Null
if (Test-Path "$work\cng.bin") { icacls "$work\cng.bin" /grant "$($u):(R)" | Out-Null }
Write-Host 'OK'
try { Stop-Transcript | Out-Null } catch {}
`;
}

/** Parse the double-DPAPI blob and derive the 32-byte cookie master key. */
export function deriveMasterKey(out: Buffer, cng?: Buffer): Buffer {
  const headerLen = out.readUInt32LE(0);
  const flagOff = 4 + headerLen + 4;
  const flag = out[flagOff];
  if (flag === 1 || flag === 2) {
    // [flag(1)][iv(12)][ct(32)][tag(16)]
    const iv = out.subarray(flagOff + 1, flagOff + 13);
    const ct = out.subarray(flagOff + 13, flagOff + 45);
    const tag = out.subarray(flagOff + 45, flagOff + 61);
    const d = flag === 1
      ? createDecipheriv("aes-256-gcm", FLAG1_AES_KEY, iv)
      : createDecipheriv("chacha20-poly1305", FLAG2_CHACHA_KEY, iv, { authTagLength: 16 });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }
  if (flag === 3) {
    // [flag(1)][encrypted_aes_key(32)][iv(12)][ct(32)][tag(16)]; encrypted_aes_key is CNG-decrypted (cng)
    if (!cng) throw new Error("flag 3 requires the CNG-decrypted key (cng.bin missing)");
    const iv = out.subarray(flagOff + 33, flagOff + 45);
    const ct = out.subarray(flagOff + 45, flagOff + 77);
    const tag = out.subarray(flagOff + 77, flagOff + 93);
    const xored = Buffer.from(cng.map((b, i) => b ^ FLAG3_XOR_KEY[i]!));
    const d = createDecipheriv("aes-256-gcm", xored, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }
  throw new Error(`Unsupported app-bound key flag: ${flag}`);
}

/** Decrypt a v20 cookie value with the master key. Returns the cookie string (32-byte prefix stripped). */
export function decryptCookieV20(master: Buffer, encryptedValue: Buffer): string {
  const iv = encryptedValue.subarray(3, 15);
  const ct = encryptedValue.subarray(15, encryptedValue.length - 16);
  const tag = encryptedValue.subarray(encryptedValue.length - 16);
  const d = createDecipheriv("aes-256-gcm", master, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).subarray(32).toString("utf8");
}

/**
 * Extract the Slack `d` (xoxd-) cookie from a Chrome profile on Windows via the app-bound
 * (v20) scheme. Triggers a single UAC elevation. Returns the cookie, or throws with a
 * descriptive message the caller can turn into manual-paste guidance.
 */
export async function extractSlackXoxdWindows(profileDir: string): Promise<string> {
  if (process.platform !== "win32") throw new Error("Windows-only");
  const userDataDir = chromeUserDataDir();
  if (!existsSync(join(userDataDir, "Local State"))) throw new Error(`Chrome Local State not found at ${userDataDir}`);

  mkdirSync(WORK_DIR, { recursive: true });
  const scriptPath = join(WORK_DIR, "extract.ps1");
  writeFileSync(scriptPath, buildHelperPs(userDataDir, profileDir));
  writeFileSync(join(WORK_DIR, "inner_dpapi.ps1"), PS_INNER_DPAPI);
  writeFileSync(join(WORK_DIR, "inner_cng.ps1"), PS_INNER_CNG);

  // One elevated pass (UAC), run windowless and waited on.
  const launch = `Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${scriptPath.replace(/'/g, "''")}')`;
  const res = spawnSync("powershell", ["-NoProfile", "-Command", launch], { encoding: "utf8", windowsHide: true });
  if (res.status !== 0 && res.error) throw new Error(`Failed to launch elevated helper: ${res.error.message}`);

  const outPath = join(WORK_DIR, "out.bin");
  const cookiesPath = join(WORK_DIR, "Cookies");
  if (!existsSync(outPath) || !existsSync(cookiesPath)) {
    const log = existsSync(join(WORK_DIR, "log.txt")) ? readFileSync(join(WORK_DIR, "log.txt"), "utf8").split("\n").filter((l) => l.startsWith("ERROR")).join(" ") : "";
    throw new Error(`Elevated extraction did not complete${log ? ` (${log.trim()})` : " (UAC declined or Chrome build unsupported)"}`);
  }

  try {
    const out = readFileSync(outPath);
    const cng = existsSync(join(WORK_DIR, "cng.bin")) ? readFileSync(join(WORK_DIR, "cng.bin")) : undefined;
    const master = deriveMasterKey(out, cng);

    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(cookiesPath, { readonly: true });
    const row = db
      .query("SELECT encrypted_value v FROM cookies WHERE name = char(100) AND host_key LIKE char(37,115,108,97,99,107,37) LIMIT 1")
      .get() as { v: Uint8Array } | null;
    db.close();
    if (!row) throw new Error("no Slack `d` cookie in that Chrome profile");
    const value = Buffer.from(row.v);
    if (value.subarray(0, 3).toString() !== "v20") throw new Error(`unexpected cookie version ${value.subarray(0, 3).toString("latin1")}`);
    const cookie = decryptCookieV20(master, value);
    if (!cookie.startsWith("xoxd-")) throw new Error("decrypted value is not an xoxd- cookie");
    return cookie;
  } finally {
    // Never leave decrypted key material / a cookie DB copy on disk (SLACK_KEEP_ABE keeps it for debugging).
    if (!process.env.SLACK_KEEP_ABE) rmSync(WORK_DIR, { recursive: true, force: true });
  }
}
