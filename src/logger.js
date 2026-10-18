'use strict';
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'data', 'french-stream-full.log');
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}

function line(level, site, op, msg, extra) {
  const t = new Date().toISOString();
  const s = `[${t}] [${level}] [${site || '-'}] [${op || '-'}] ${msg}${extra ? ' | ' + JSON.stringify(extra).slice(0, 500) : ''}\n`;
  try { fs.appendFileSync(LOG_FILE, s); } catch {}
  if (process.env.FSF_VERBOSE || level === 'ERROR') console.log(s.trim());
}

module.exports = {
  info: (site, op, msg, extra) => line('INFO', site, op, msg, extra),
  warn: (site, op, msg, extra) => line('WARN', site, op, msg, extra),
  error: (site, op, msg, extra) => line('ERROR', site, op, msg, extra),
  LOG_FILE
};
