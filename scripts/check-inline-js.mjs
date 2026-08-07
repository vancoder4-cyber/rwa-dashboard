import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
if (!scripts.length) throw new Error('No inline scripts found');
scripts.forEach((source, index) => {
  try {
    new Function(source);
  } catch (error) {
    throw new SyntaxError(`Inline script ${index + 1}: ${error.message}`);
  }
});
console.log(`Validated ${scripts.length} inline script block(s).`);
