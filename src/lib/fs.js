const fs = require('fs/promises');
const path = require('path');

const RETRYABLE_WRITE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const WRITE_RETRY_ATTEMPTS = process.platform === 'win32' ? 12 : 4;

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    // SyntaxError: file bị corrupt hoặc đọc trúng lúc đang write
    // Trả về fallback thay vì crash server
    if (error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  // Ghi ra file tạm rồi rename — rename là atomic trên cùng filesystem,
  // đảm bảo reader không bao giờ thấy file nửa chừng
  const tmpPath = uniqueTmpPath(filePath);
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    await replaceFileWithRetry(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

function uniqueTmpPath(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return path.join(dir, `.${base}.${nonce}.tmp`);
}

async function replaceFileWithRetry(tmpPath, filePath) {
  let lastError = null;

  for (let attempt = 1; attempt <= WRITE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableWriteError(error) || attempt === WRITE_RETRY_ATTEMPTS) {
        break;
      }

      if (process.platform === 'win32' && attempt >= Math.ceil(WRITE_RETRY_ATTEMPTS / 2)) {
        try {
          await replaceViaBackup(tmpPath, filePath);
          return;
        } catch (backupError) {
          lastError = backupError;
          if (!isRetryableWriteError(backupError)) {
            break;
          }
        }
      }

      await sleepMs(retryDelayMs(attempt));
    }
  }

  throw lastError;
}

async function replaceViaBackup(tmpPath, filePath) {
  const backupPath = uniqueTmpPath(`${filePath}.bak`);
  let hasBackup = false;

  try {
    await fs.rename(filePath, backupPath);
    hasBackup = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await fs.rename(tmpPath, filePath);
    if (hasBackup) {
      await fs.rm(backupPath, { force: true }).catch(() => {});
    }
  } catch (error) {
    if (hasBackup) {
      await fs.rename(backupPath, filePath).catch(() => {});
    }
    throw error;
  }
}

function isRetryableWriteError(error) {
  return RETRYABLE_WRITE_CODES.has(error?.code);
}

function retryDelayMs(attempt) {
  return Math.min(1000, 25 * (2 ** Math.min(attempt - 1, 5)));
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) return true;
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function removePath(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

function isReadableVideoFile(filePath, ffprobePath, expectedDuration = null, toleranceSec = 1.5) {
  const fsSync = require('fs');
  const { spawnSync } = require('child_process');
  let stat = null;
  try {
    stat = fsSync.statSync(filePath);
  } catch {
    return false;
  }
  // Tệp tin video tối thiểu phải lớn hơn 10KB
  if (!stat.isFile() || stat.size < 10000) {
    return false;
  }

  const resolvedFfprobe = ffprobePath || process.env.VIBE_TOOL_FFPROBE_PATH || 'ffprobe';
  try {
    const result = spawnSync(resolvedFfprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (result.status !== 0) return false;
    const durationStr = String(result.stdout || '').trim();
    const actualDuration = Number(durationStr);
    if (!Number.isFinite(actualDuration) || actualDuration <= 0) {
      return false;
    }
    if (expectedDuration !== null && expectedDuration > 0) {
      // Nếu thời lượng thực tế ngắn hơn thời lượng mong muốn vượt quá mức sai số cho phép
      if (actualDuration < expectedDuration - toleranceSec) {
        return false;
      }
    }
    return true;
  } catch {
    return stat.size >= 10000;
  }
}

module.exports = {
  ensureDir,
  readJson,
  writeJson,
  exists,
  removePath,
  isReadableVideoFile
};
