const fs = require('fs');

function safePatch(filePath, oldText, newText) {
  const content = fs.readFileSync(filePath, 'utf8');
  const count = content.split(oldText).length - 1;

  if (count === 0) {
    console.error(`❌ ${filePath}: expected text not found. File may already be patched, or differs from what I expected. Nothing changed.`);
    return false;
  }
  if (count > 1) {
    console.error(`❌ ${filePath}: expected text found ${count} times (expected exactly 1). Refusing to guess which one. Nothing changed.`);
    return false;
  }

  fs.writeFileSync(filePath + '.bak', content);
  fs.writeFileSync(filePath, content.replace(oldText, newText));
  console.log(`✅ ${filePath}: patched (backup saved as ${filePath}.bak)`);
  return true;
}

module.exports = safePatch;
