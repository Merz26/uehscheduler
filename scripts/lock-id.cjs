const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' }
});
const key = publicKey.toString('base64');
const hash = crypto.createHash('sha256').update(publicKey).digest('hex');
const id = hash.slice(0, 32).split('').map(c => {
  return c >= 'a' ? String.fromCharCode(c.charCodeAt(0) + 10) : String.fromCharCode(c.charCodeAt(0) + 49);
}).join('');

console.log("Generated UEH Extension Key & ID:");
console.log("KEY: " + key);
console.log("ID: " + id);

const manifestPath = path.resolve(__dirname, '../manifest.json');
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.key = key;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log("Updated manifest.json with new extension key successfully.");
}

