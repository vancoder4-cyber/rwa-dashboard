import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export function migrationChecksum(sqlText) {
  return createHash('sha256').update(String(sqlText), 'utf8').digest('hex');
}

export function splitSqlStatements(sqlText) {
  const source = String(sqlText || '');
  const statements = [];
  let statement = '';
  let index = 0;
  let quote = null;
  let dollarTag = null;
  let lineComment = false;
  let blockCommentDepth = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1] || '';

    if (lineComment) {
      statement += char;
      index += 1;
      if (char === '\n') lineComment = false;
      continue;
    }

    if (blockCommentDepth > 0) {
      statement += char;
      if (char === '/' && next === '*') {
        statement += next;
        blockCommentDepth += 1;
        index += 2;
      } else if (char === '*' && next === '/') {
        statement += next;
        blockCommentDepth -= 1;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        statement += dollarTag;
        index += dollarTag.length;
        dollarTag = null;
      } else {
        statement += char;
        index += 1;
      }
      continue;
    }

    if (quote) {
      statement += char;
      if (char === quote) {
        if (next === quote) {
          statement += next;
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      statement += `${char}${next}`;
      lineComment = true;
      index += 2;
      continue;
    }

    if (char === '/' && next === '*') {
      statement += `${char}${next}`;
      blockCommentDepth = 1;
      index += 2;
      continue;
    }

    if (char === '\'' || char === '"') {
      statement += char;
      quote = char;
      index += 1;
      continue;
    }

    if (char === '$') {
      const match = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        statement += dollarTag;
        index += dollarTag.length;
        continue;
      }
    }

    if (char === ';') {
      if (statement.trim()) statements.push(statement.trim());
      statement = '';
      index += 1;
      continue;
    }

    statement += char;
    index += 1;
  }

  if (quote || dollarTag || blockCommentDepth > 0) {
    throw new Error('SQL migration contains an unterminated quote or comment');
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

export async function loadMigrations(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrationFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => {
      const match = entry.name.match(MIGRATION_FILE_PATTERN);
      if (!match) throw new Error(`Invalid migration filename: ${entry.name}`);
      return { filename: entry.name, version: match[1], name: match[2] };
    })
    .sort((left, right) => left.filename.localeCompare(right.filename));

  const seenVersions = new Set();
  const migrations = [];
  for (const migrationFile of migrationFiles) {
    if (seenVersions.has(migrationFile.version)) {
      throw new Error(`Duplicate migration version: ${migrationFile.version}`);
    }
    seenVersions.add(migrationFile.version);
    const filePath = path.join(directory, migrationFile.filename);
    const sql = await readFile(filePath, 'utf8');
    const statements = splitSqlStatements(sql);
    if (statements.length === 0) throw new Error(`Empty migration: ${migrationFile.filename}`);
    migrations.push({
      ...migrationFile,
      filePath,
      sql,
      statements,
      checksum: migrationChecksum(sql),
    });
  }
  return migrations;
}
