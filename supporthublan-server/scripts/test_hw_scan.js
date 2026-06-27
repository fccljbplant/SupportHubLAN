// Test hardware scan — write to file then read back (bypass PsExec stdout issues)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PSTOOLS_PATH = 'C:\\PSTools\\';
const target = '192.168.10.31';
const cred = {
  username: 'Deskadmin',
  password: 'Fauji$#@1',
  domain: 'plant.fccl.com'
};

const exe = path.join(PSTOOLS_PATH, 'psexec.exe');
const fullUser = cred.domain + '\\' + cred.username;

// Step 1: Create batch file that writes to C:\Windows\Temp\_hw6.txt
const batchPath = path.join(process.env.TEMP, '_hw_collect.cmd');
const batchContent = [
  '@echo off',
  'hostname > C:\\Windows\\Temp\\_hw6.txt 2>&1',
  'echo ===BIOS=== >> C:\\Windows\\Temp\\_hw6.txt',
  'reg query HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS /v SystemManufacturer >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  'reg query HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS /v SystemProductName >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  'reg query HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS /v SystemSerialNumber >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  'reg query HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS /v BaseBoardManufacturer >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  'reg query HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS /v BaseBoardProduct >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  'reg query HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS /v BIOSVendor >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  'reg query HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS /v BIOSVersion >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  'echo ===OS=== >> C:\\Windows\\Temp\\_hw6.txt',
  // Use reg.exe path explicitly to avoid aliasing
  '%SystemRoot%\\System32\\reg.exe query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v ProductName >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  '%SystemRoot%\\System32\\reg.exe query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v DisplayVersion >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  '%SystemRoot%\\System32\\reg.exe query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v CurrentBuild >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  'echo ===CPU=== >> C:\\Windows\\Temp\\_hw6.txt',
  '%SystemRoot%\\System32\\reg.exe query "HKLM\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0" /v ProcessorNameString >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  '%SystemRoot%\\System32\\reg.exe query "HKLM\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0" /v ~MHz >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  'echo ===DOMAIN=== >> C:\\Windows\\Temp\\_hw6.txt',
  '%SystemRoot%\\System32\\reg.exe query "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters" /v Domain >> C:\\Windows\\Temp\\_hw6.txt 2>&1',
  'echo DONE >> C:\\Windows\\Temp\\_hw6.txt',
  'exit /b 0'
].join('\r\n');

fs.writeFileSync(batchPath, batchContent, 'ascii');

function runPsExec(args) {
  return new Promise((resolve) => {
    const proc = spawn(exe, args, { windowsHide: true });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const baseArgs = ['-accepteula', '\\\\' + target, '-u', fullUser, '-p', cred.password, '-s', '-h'];

  // Step 1: Copy and run collection batch
  console.log('Step 1: Running collection batch...');
  const r1 = await runPsExec([...baseArgs, '-c', '-f', batchPath]);
  console.log('Exit:', r1.code);
  console.log('Stdout:', r1.stdout.trim());
  console.log('Stderr:', r1.stderr.split('\n').filter(l => l.trim() && !l.startsWith('Connecting') && !l.startsWith('Starting') && !l.startsWith('Copying')).join('\n').trim());

  // Small delay for file write
  await new Promise(r => setTimeout(r, 2000));

  // Step 2: Read the output file
  console.log('\nStep 2: Reading output file...');
  const r2 = await runPsExec([...baseArgs, 'cmd.exe', '/c', 'type', 'C:\\Windows\\Temp\\_hw6.txt']);
  console.log('Exit:', r2.code);
  console.log('\n=== COLLECTED DATA ===');
  const data = r2.stdout.split('\n').filter(l => {
    const t = l.trim();
    if (!t) return false;
    if (/^PsExec v/i.test(t) || /^Copyright/i.test(t) || /^Sysinternals/i.test(t)) return false;
    return true;
  });
  console.log(data.join('\n'));
}

main().catch(e => console.error(e));
