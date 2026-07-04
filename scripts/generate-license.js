const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LICENSE_SALT = 'vibe_tool_video_super_secret_salt_2026';

function generateSignature(machineId, expiresAt) {
  return crypto
    .createHmac('sha256', LICENSE_SALT)
    .update(`${machineId}:${expiresAt}`)
    .digest('hex')
    .toUpperCase();
}

function printUsage() {
  console.log('Cách dùng:');
  console.log('  node scripts/generate-license.js --machine <MACHINE_ID> --days <SỐ_NGÀY_HẠN> [--out <ĐƯỜNG_DẪN_GHI>]');
  console.log('Ví dụ:');
  console.log('  node scripts/generate-license.js --machine E1F2A3D4B5C6D7E8F90123456789ABCD --days 365 --out license.lic');
  process.exit(1);
}

const args = process.argv.slice(2);
let machineId = '';
let days = 365;
let outPath = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--machine' && args[i + 1]) {
    machineId = args[i + 1].trim().toUpperCase();
    i++;
  } else if (args[i] === '--days' && args[i + 1]) {
    days = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--out' && args[i + 1]) {
    outPath = args[i + 1].trim();
    i++;
  }
}

if (!machineId || isNaN(days)) {
  printUsage();
}

const expirationDate = new Date();
expirationDate.setDate(expirationDate.getDate() + days);
const expiresAt = expirationDate.toISOString().split('T')[0];

const signature = generateSignature(machineId, expiresAt);

const licenseObj = {
  machineId,
  expiresAt,
  signature
};

const licenseContent = JSON.stringify(licenseObj, null, 2);

console.log('\n--- THÔNG TIN BẢN QUYỀN ĐÃ TẠO ---');
console.log(licenseContent);
console.log('----------------------------------\n');

if (outPath) {
  fs.writeFileSync(outPath, licenseContent, 'utf8');
  console.log(`Ghi file bản quyền thành công ra: ${path.resolve(outPath)}`);
} else {
  fs.writeFileSync('license.lic', licenseContent, 'utf8');
  console.log('Ghi file bản quyền mặc định thành công ra: ./license.lic');
}
