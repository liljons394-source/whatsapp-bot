const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

// --- CONFIGURATION ---
const SESSION_ID = 'tct_d4c1f22';
const binaryName = 'tct-linux';
const binaryDownloadUrl = 'https://github.com/i-tct/tct/releases/latest/download/tct-linux';

const tctfileUrl = 'https://gist.githubusercontent.com/i-tct/1433de6fbe3a14f2178e5429b46c31c0/raw/tctfile';

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Request Failed. Status Code: ${res.statusCode}`));
      }

      const fileStream = fs.createWriteStream(dest);
      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });

      fileStream.on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    });

    req.on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

/*
------------------------------------------
CONFIG HANDLING ( tctfile)
------------------------------------------
*/

async function ensureTctFile() {
  const configFile = 'tctfile';

  try {
    if (fs.existsSync('.env')) fs.unlinkSync('.env');
  } catch (_) {}

  if (!fs.existsSync(configFile)) {
    console.log('[Init] tctfile does not exist, downloading from repository...');
    try {
      await downloadFile(tctfileUrl, configFile);
      console.log('[Init] tctfile downloaded successfully.');
    } catch (err) {
      console.error('[Init] Failed to download tctfile:', err.message);
      process.exit(1);
    }
  }

  console.log('[Init] Ensuring SESSION_ID is set in tctfile...');
  let content = fs.readFileSync(configFile, 'utf8');
  const sessionRegex = /^[ \t]*SESSION_ID:.*$/m;

  if (sessionRegex.test(content)) {
    content = content.replace(sessionRegex, `SESSION_ID: "${SESSION_ID}"`);
  } else {
    if (!content.endsWith('\n')) content += '\n';
    content += `SESSION_ID: "${SESSION_ID}"\n`;
  }

  fs.writeFileSync(configFile, content);
  console.log('[Init] tctfile configured successfully.');
}

function tryMakeExecutable(absPath) {
  try {
    fs.chmodSync(absPath, 0o755);
    return true;
  } catch (e) {
    console.error(`[Init] Failed to set permissions: ${e.message}`);
    return false;
  }
}

/*
------------------------------------------
SUPERVISOR
------------------------------------------
*/

function startBinarySupervisor() {
  const absBin = path.resolve('./', binaryName);

  if (!fs.existsSync(absBin)) {
    console.error(`[Launcher] Binary ${absBin} not found.`);
    process.exit(1);
  }

  tryMakeExecutable(absBin);

  const env = Object.assign({}, process.env, {
    DISABLE_SESSION_DOWNLOAD: 'false',
    FORCE_COLOR: '1'
  });

  let child = null;
  let restartCount = 0;
  let stopping = false;
  let restartTimer = null;

  function spawnChild() {
    console.log(`[Launcher] Starting binary: ${absBin}`);

    child = spawn(absBin, [], { env, stdio: 'inherit' });

    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;

      console.warn(`[Launcher] Child exited (code=${code}, signal=${signal})`);
      restartCount++;

      const backoff = Math.min(1000 * Math.pow(2, Math.min(restartCount, 6)), 30000);
      restartTimer = setTimeout(spawnChild, backoff);
    });

    child.on('error', (err) => {
      console.error('[Launcher] Spawn error:', err.message);
      if (!stopping) {
        restartCount++;
        const backoff = Math.min(1000 * Math.pow(2, Math.min(restartCount, 6)), 30000);
        restartTimer = setTimeout(spawnChild, backoff);
      }
    });
  }

  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`[Launcher] Received ${signal}`);

    if (restartTimer) clearTimeout(restartTimer);

    if (child) {
      child.kill(signal);
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        process.exit(0);
      }, 10000);
    } else {
      process.exit(0);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  spawnChild();
}

/*
------------------------------------------
MAIN
------------------------------------------
*/

(async function main() {
  try {
    // 1. Ensure Binary
    if (fs.existsSync(binaryName)) {
      console.log(`[Init] Binary found. Skipping download.`);
    } else {
      console.log(`[Init] Downloading binary...`);
      await downloadFile(binaryDownloadUrl, binaryName);
      tryMakeExecutable(binaryName);
    }

    // 2. Ensure Configuration
    await ensureTctFile();

    // 3. Start Bot
    startBinarySupervisor();
  } catch (err) {
    console.error('Fatal Init Error:', err);
    process.exit(1);
  }
})();
