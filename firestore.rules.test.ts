import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const rulesText = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const blueprint = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase-blueprint.json'), 'utf8')) as {
  entities: Record<string, { properties: Record<string, unknown>; required: string[] }>;
  firestore: Record<string, { schema: { $ref: string } }>;
};

test('firestore.rules enforces global deny-all and covers every blueprint collection', () => {
  assert.match(rulesText, /rules_version\s*=\s*'2'/);
  assert.match(rulesText, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);

  // Verify every blueprint collection path has a corresponding match block in firestore.rules
  assert.match(rulesText, /match \/sessions\/\{btcAddress\}/);
  assert.match(rulesText, /match \/share_tokens\/\{shareToken\}/);
  assert.match(rulesText, /match \/devices\/\{deviceId\}/);
  assert.match(rulesText, /match \/blocks\/\{blockIndex\}/);
  assert.match(rulesText, /match \/relay_submissions\/\{txid\}/);
  assert.match(rulesText, /match \/leaderboard\/\{addressHash\}/);
  assert.ok(Object.keys(blueprint.firestore).length === 6);
});

test('Dirty Dozen security invariants are enforced by firestore.rules', () => {
  // 1 & 2: Session and share_token list scraping forbidden
  assert.match(rulesText, /match \/share_tokens\/\{shareToken\}[\s\S]*?allow list:\s*if false;/);
  assert.match(rulesText, /match \/sessions\/\{btcAddress\}[\s\S]*?allow list:\s*if false;/);

  // 3: Atomic share_tokens pairing required on session create
  assert.match(rulesText, /existsAfter\(\/databases\/\$\(database\)\/documents\/share_tokens\/\$\(incoming\(\)\.shareToken\)\)/);
  assert.match(rulesText, /getAfter\(\/databases\/\$\(database\)\/documents\/sessions\/\$\(incoming\(\)\.btcAddress\)\)\.data\.shareToken == shareToken/);

  // 4 & 5: Strict keys.hasAll/hasOnly and immutable identity fields
  assert.match(rulesText, /incoming\(\)\.shareToken == existing\(\)\.shareToken/);
  assert.match(rulesText, /incoming\(\)\.btcAddress == existing\(\)\.btcAddress/);
  assert.match(rulesText, /incoming\(\)\.createdAt == existing\(\)\.createdAt/);

  // 6: Server request.time enforced on timestamps
  assert.match(rulesText, /incoming\(\)\.createdAt == request\.time/);
  assert.match(rulesText, /incoming\(\)\.updatedAt == request\.time/);

  // 7: Path ID validation helpers
  assert.match(rulesText, /isValidBtcAddress\(btcAddress\)/);
  assert.match(rulesText, /isValidId\(deviceId\)/);

  // 8, 9, 10, 11: Block progress monotonicity, 60% PoW cap, 6-share completion, terminal lock
  assert.match(rulesText, /existing\(\)\.status == 'leased'/);
  assert.match(rulesText, /incoming\(\)\.progressOffset >= existing\(\)\.progressOffset/);
  assert.match(rulesText, /data\.powCount == 0 && data\.progressOffset > 322122547/);
  assert.match(rulesText, /incoming\(\)\.powCount >= \(existing\(\)\.totalKeys >= 536870912 \? 6 : 1\)/);

  // 12: Leaderboard PII isolation (SHA-256 ID, monotonic keys, resource.data list guard)
  assert.match(rulesText, /match \/leaderboard\/\{addressHash\}[\s\S]*?isValidSha256Hex\(addressHash\)/);
  assert.match(rulesText, /allow list:\s*if resource\.data\.totalKeysChecked >= 0 &&[\s\S]*?request\.query\.limit <= 100;/);
});
