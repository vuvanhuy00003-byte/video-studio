const fs = require('fs');
const path = require('path');

function appResourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'app'
    );
  }
  return path.join(context.appOutDir, 'resources', 'app');
}

exports.default = async function afterPack(context) {
  const source = path.join(context.packager.projectDir, 'node_modules', '9router', 'app', 'node_modules');
  const target = path.join(appResourcesDir(context), 'node_modules', '9router', 'app', 'node_modules');
  if (!fs.existsSync(source)) {
    throw new Error(`Missing 9Router app dependencies: ${source}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const betterSqlitePath = path.join(source, 'better-sqlite3');
  fs.cpSync(source, target, {
    recursive: true,
    filter: (sourcePath) => sourcePath !== betterSqlitePath
  });
};
