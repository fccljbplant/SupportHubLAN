const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const pstoolsPath = path.join(__dirname, 'PSTools') + path.sep;
const hostname = 'ADMIN-PC-01049.plant.fccl.com';
const cred = { username: 'deskadmin', password: 'Fauji$#@1', domain: 'plant.fccl.com', fullUsername: 'plant.fccl.com\\deskadmin', source: 'env-default' };

function credentialArgs(credential, hostname) {
  if (!credential || !credential.username || !credential.password) return [];
  let fullUser;
  if (credential.source === 'fallback' && hostname) {
    const shortName = hostname.includes('.') ? hostname.split('.')[0] : hostname;
    fullUser = shortName + '\\' + credential.username;
  } else {
    fullUser = credential.domain ? `${credential.domain}\\${credential.username}` : credential.username;
  }
  return ['-u', fullUser, '-p', credential.password];
}

const psScript = `
  $ErrorActionPreference = 'Stop'
  $apps = @()
  try {
    $paths = @(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    )
    foreach ($p in $paths) {
      try { Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object { $apps += @{ name = $_.DisplayName; version = if ($_.DisplayVersion) { $_.DisplayVersion } else { '' }; publisher = if ($_.Publisher) { $_.Publisher } else { '' } } } } catch {}
    }
    $apps = @($apps | Sort-Object { $_.name } -Unique)
  } catch {
    $apps = @()
  }
  Write-Output ('<<<JSON>>>' + ($apps | ConvertTo-Json -Compress -Depth 2) + '<<<END>>>')
`;

const encodedScript = Buffer.from(psScript, 'utf16le').toString('base64');
const exe = path.join(pstoolsPath, 'psexec.exe');
const args = ['-accepteula', '\\\\' + hostname,
  ...credentialArgs(cred, hostname),
  '-s', '-h',
  'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript];

console.log('Command:', exe, args.join(' ').replace(/-p\s+\S+/g, '-p ***'));
console.log('Starting...');

const proc = spawn(exe, args, { windowsHide: true, timeout: 60000 });
let stdout = '', stderr = '';

proc.stdout.on('data', (d) => { stdout += d.toString(); });
proc.stderr.on('data', (d) => { stderr += d.toString(); });

proc.on('error', (err) => {
  console.log('ERROR:', err.message);
  process.exit(1);
});

proc.on('close', (code) => {
  console.log('Exit code:', code);
  console.log('stdout length:', stdout.length);
  console.log('stderr length:', stderr.length);
  console.log('has <<<JSON>>>:', stdout.includes('<<<JSON>>>'));
  console.log('has <<<END>>>:', stdout.includes('<<<END>>>'));
  
  const idx = stdout.indexOf('<<<JSON>>>');
  if (idx >= 0) {
    const tailFromMarker = stdout.substring(idx);
    console.log('From <<<JSON>>> length:', tailFromMarker.length);
    console.log('Tail from marker (last 200 chars):', JSON.stringify(tailFromMarker.slice(-200)));
    console.log('Has END in tail:', tailFromMarker.includes('<<<END>>>'));
    
    if (tailFromMarker.includes('<<<END>>>')) {
      const endIdx = tailFromMarker.indexOf('<<<END>>>');
      const jsonStr = tailFromMarker.substring('<<<JSON>>>'.length, endIdx);
      console.log('JSON string length:', jsonStr.length);
      try {
        const apps = JSON.parse(jsonStr);
        console.log('Parsed OK:', apps.length, 'apps');
      } catch (e) {
        console.log('JSON parse error:', e.message);
        console.log('Last 100 chars of JSON:', JSON.stringify(jsonStr.slice(-100)));
      }
    }
  }
  
  process.exit(0);
});
