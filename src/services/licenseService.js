const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const LICENSE_SALT = 'vibe_tool_video_super_secret_salt_2026';

function execAsync(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (error, stdout) => {
      if (error) resolve('');
      else resolve(String(stdout).trim());
    });
  });
}

async function getRawHardwareId() {
  if (process.platform === 'win32') {
    const raw = await execAsync('powershell -Command "(Get-CimInstance Win32_BIOS).SerialNumber + (Get-CimInstance Win32_Processor).ProcessorId"');
    if (raw) return raw;
    // Fallback if PowerShell command failed
    const wmicCpu = await execAsync('wmic cpu get processorid');
    const wmicBios = await execAsync('wmic bios get serialnumber');
    return `${wmicCpu}${wmicBios}`.replace(/\s+/g, '');
  } else if (process.platform === 'darwin') {
    return execAsync("ioreg -rd1 -c IOPlatformExpertDevice | awk -F'\"' '/IOPlatformUUID/ {print $4}'");
  } else {
    // Linux fallback
    const machineId = await fs.readFile('/etc/machine-id', 'utf8').catch(() => '');
    if (machineId) return machineId.trim();
    const cpuinfo = await fs.readFile('/proc/cpuinfo', 'utf8').catch(() => '');
    return cpuinfo.replace(/\s+/g, '');
  }
}

async function getMachineId() {
  const raw = await getRawHardwareId();
  if (!raw) return 'UNKNOWN_MACHINE';
  return crypto.createHash('sha256').update(raw + LICENSE_SALT).digest('hex').substring(0, 32).toUpperCase();
}

function generateSignature(machineId, expiresAt) {
  return crypto
    .createHmac('sha256', LICENSE_SALT)
    .update(`${machineId}:${expiresAt}`)
    .digest('hex')
    .toUpperCase();
}

function verifyLicenseData(licenseObj, currentMachineId) {
  if (!licenseObj || !licenseObj.machineId || !licenseObj.expiresAt || !licenseObj.signature) {
    return { valid: false, reason: 'File bản quyền không hợp lệ hoặc bị thiếu thông tin.' };
  }
  if (licenseObj.machineId !== currentMachineId) {
    return { valid: false, reason: 'Mã máy đăng ký không trùng khớp với máy này.' };
  }
  const expectedSignature = generateSignature(licenseObj.machineId, licenseObj.expiresAt);
  if (licenseObj.signature !== expectedSignature) {
    return { valid: false, reason: 'Chữ ký số bản quyền không hợp lệ (đã bị chỉnh sửa).' };
  }
  const expiresTime = new Date(licenseObj.expiresAt).getTime();
  if (isNaN(expiresTime) || Date.now() > expiresTime) {
    return { valid: false, reason: `Thời hạn sử dụng đã hết (Ngày hết hạn: ${licenseObj.expiresAt}).` };
  }
  return { valid: true, expiresAt: licenseObj.expiresAt };
}

async function checkLicenseStatus(dataPath) {
  const licPath = path.join(dataPath, 'license.lic');
  try {
    const content = await fs.readFile(licPath, 'utf8');
    const licenseObj = JSON.parse(content);
    const machineId = await getMachineId();
    return verifyLicenseData(licenseObj, machineId);
  } catch (err) {
    return { valid: false, reason: 'Chưa kích hoạt bản quyền.' };
  }
}

module.exports = {
  getMachineId,
  generateSignature,
  verifyLicenseData,
  checkLicenseStatus,
  LICENSE_SALT
};
