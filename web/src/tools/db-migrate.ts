import { migrateDatabaseFile } from '../services/sessions/db.js';

const path = process.argv[2] ?? process.env.DB_PATH;
if (!path) {
  throw new Error('usage: node dist/tools/db-migrate.js <database-path>');
}
const result = migrateDatabaseFile(path);
// Deliberately contains only schema metadata, never row content or secrets.
console.log(JSON.stringify(result));
