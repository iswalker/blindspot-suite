// Writes db/schema.sql from lib/schema.js:  node db/export-schema.js
const fs = require('fs');
const path = require('path');
const { STATEMENTS } = require('../lib/schema.js');

// One column / constraint per line for CREATE TABLE statements (other statements stay as written).
function pretty(sql) {
  sql = sql.replace(/\s+/g, ' ').trim();
  var m = sql.match(/^(CREATE TABLE IF NOT EXISTS \S+) \((.*)\)$/);
  if (!m) return sql;
  var parts = [], depth = 0, cur = '';
  for (var i = 0; i < m[2].length; i++) {
    var ch = m[2].charAt(i);
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  return m[1] + ' (\n  ' + parts.join(',\n  ') + '\n)';
}

const header = '-- Generated from lib/schema.js by db/export-schema.js -- edit that file, not this one.\n' +
  '-- Applying it by hand is optional (the API creates these tables on first use):\n' +
  '--   turso db shell <your-db> < db/schema.sql\n\n';
fs.writeFileSync(path.join(__dirname, 'schema.sql'), header + STATEMENTS.map(function(s) { return pretty(s) + ';\n'; }).join('\n'));
console.log('wrote db/schema.sql');
