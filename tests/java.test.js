'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/core/config');
const settings = require('../src/core/settings');
const java = require('../src/core/java');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minepilot-java-test-'));
try {
  config.init(root);
  assert.strictEqual(java.requiredJava('1.20.4'), 17);
  assert.strictEqual(java.requiredJava('1.20.5'), 21);
  assert.strictEqual(java.requiredJava('1.21.1'), 21);
  assert.strictEqual(java.requiredJava('1.16.5'), 8);
  assert.strictEqual(java.requiredJava('1.17.1'), 17);
  assert.strictEqual(java.requiredJava('1.20.1', 21), 21);
  assert.ok(java.JAVA_VENDORS.temurin && java.JAVA_VENDORS.zulu && java.JAVA_VENDORS.corretto);

  const extra = path.join(root, 'fake-java');
  const saved = settings.update({
    javaExtraPaths: [extra, extra],
    javaIgnorePaths: [`${root}\\ignored`],
    javaVersionOverrides: { '1.20.1-fabric': extra },
    javaVendor: 'zulu',
  });
  assert.deepStrictEqual(saved.javaExtraPaths, [extra]);
  assert.strictEqual(saved.javaVersionOverrides['1.20.1-fabric'], extra);
  assert.strictEqual(saved.javaVendor, 'zulu');

  const invalid = java.inspect(path.join(root, 'not-java.txt'));
  assert.strictEqual(invalid, null);

  console.log('java tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}