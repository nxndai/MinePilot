'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/core/config');
const accounts = require('../src/core/accounts');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-accounts-test-'));
const secure = {
  backend: 'test-keychain',
  isAvailable: () => true,
  encrypt: (value) => `sealed:${Buffer.from(String(value), 'utf8').toString('base64')}`,
  decrypt: (value) => Buffer.from(String(value).replace(/^sealed:/, ''), 'base64').toString('utf8'),
};

async function run() {
  config.init(root);
  fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify({
    microsoft: {
      name: 'LegacyPlayer',
      uuid: '00000000-0000-0000-0000-000000000001',
      accessToken: 'legacy-access-token',
      refreshToken: 'legacy-refresh-token',
      expiresAt: Date.now() + 3600_000,
    },
  }), 'utf8');

  assert.strictEqual(accounts.encryptionInfo().available, false);
  assert.strictEqual(accounts.encryptionInfo().backend, 'none');
  accounts.setSecureStore(secure);
  assert.strictEqual(accounts.encryptionInfo().available, true);

  const migrated = accounts.summary();
  assert.strictEqual(migrated.authenticated, true);
  assert.strictEqual(migrated.name, 'LegacyPlayer');
  assert.strictEqual(migrated.encryption.available, true);

  // 迁移后文件里不能再出现明文令牌，但模块内部仍能解密并启动。
  const raw = fs.readFileSync(path.join(root, 'accounts.json'), 'utf8');
  assert.ok(!raw.includes('legacy-access-token'));
  assert.ok(!raw.includes('legacy-refresh-token'));
  assert.ok(raw.includes('safeStorage'));

  const profile = await accounts.profileFor({ authMode: 'microsoft' });
  assert.strictEqual(profile.name, 'LegacyPlayer');
  assert.strictEqual(profile.accessToken, 'legacy-access-token');

  const offline = accounts.addOffline('Alex', '主号');
  assert.strictEqual(offline.name, 'Alex');
  assert.strictEqual(offline.note, '主号');
  assert.strictEqual(offline.active, true);
  assert.strictEqual(accounts.summary().authenticated, false);

  const offlineProfile = await accounts.profileFor({ authMode: 'offline', offlineName: 'Steve' });
  assert.strictEqual(offlineProfile.name, 'Alex');

  accounts.updateAccount(offline.id, { note: '备用账户' });
  assert.strictEqual(accounts.list().find((item) => item.id === offline.id).note, '备用账户');

  accounts.setMicrosoft({
    name: 'SecondPlayer',
    uuid: '00000000-0000-0000-0000-000000000002',
    accessToken: 'second-access',
    refreshToken: 'second-refresh',
    expiresAt: Date.now() + 3600_000,
  });
  const all = accounts.list();
  assert.strictEqual(all.filter((item) => item.type === 'microsoft').length, 2);
  assert.strictEqual(all.find((item) => item.active).name, 'SecondPlayer');

  const removed = accounts.removeAccount(offline.id);
  assert.strictEqual(removed.ok, true);
  assert.ok(!accounts.list().some((item) => item.id === offline.id));

  const secondRaw = fs.readFileSync(path.join(root, 'accounts.json'), 'utf8');
  assert.ok(!secondRaw.includes('second-access'));

  console.log('accounts tests passed');
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    accounts.setSecureStore(null);
    fs.rmSync(root, { recursive: true, force: true });
  });