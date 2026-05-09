const path = require('path');
const fs = require('fs');

let db = null;
let initPromise = null;
const DB_PATH = path.join(__dirname, 'court.db');

function saveDb() {
  if (db) {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      phone TEXT,
      username TEXT,
      password_hash TEXT,
      is_paid INTEGER DEFAULT 0,
      paid_expires_at TEXT,
      reset_token TEXT,
      reset_expires_at TEXT,
      balance REAL DEFAULT 0,
      recharged_at TEXT,
      lifetime INTEGER DEFAULT 0,
      must_change_password INTEGER DEFAULT 0,
      device_token TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      refund_amount REAL NOT NULL,
      refund_time TEXT NOT NULL,
      refund_reason TEXT NOT NULL,
      refund_proof TEXT,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS payment_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT,
      trade_no TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ip TEXT,
      action TEXT NOT NULL,
      file_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS sms_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      code TEXT NOT NULL,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      device_fp TEXT,
      ip TEXT,
      success INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS sms_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      params TEXT NOT NULL,
      court TEXT,
      case_number TEXT,
      doc_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS balance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      refund_id INTEGER,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS invite_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inviter_id INTEGER NOT NULL,
      invitee_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS invite_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      reward_type TEXT NOT NULL,
      reward_desc TEXT,
      granted_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );
  `);
}

// 缓存的初始化 Promise，多个请求共享同一个
function getDb() {
  if (!initPromise) {
    initPromise = (async () => {
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      let data = null;
      if (fs.existsSync(DB_PATH)) {
        data = fs.readFileSync(DB_PATH);
      }
      db = data ? new SQL.Database(data) : new SQL.Database();
      initTables();
      // 迁移：添加可能缺失的列
      const migrations = [
        "ALTER TABLE users ADD COLUMN balance REAL DEFAULT 0",
        "ALTER TABLE users ADD COLUMN lifetime INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN recharged_at TEXT",
        "ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN device_token TEXT",
        "ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1",
        "ALTER TABLE users ADD COLUMN email TEXT",
        "ALTER TABLE users ADD COLUMN username TEXT",
        "ALTER TABLE sms_history ADD COLUMN params TEXT",
        "ALTER TABLE sms_history ADD COLUMN court TEXT",
        "ALTER TABLE sms_history ADD COLUMN case_number TEXT",
        "ALTER TABLE sms_history ADD COLUMN doc_count INTEGER DEFAULT 0",
      ];
      for (const sql of migrations) {
        try { db.run(sql); } catch {}
      }

      // v3.0: 微信支付相关字段迁移
      const wxMigrations = [
        "ALTER TABLE payment_records ADD COLUMN recharge_type TEXT",
        "ALTER TABLE payment_records ADD COLUMN recharge_months INTEGER DEFAULT 0",
        "ALTER TABLE payment_records ADD COLUMN wx_transaction_id TEXT",
        "ALTER TABLE payment_records ADD COLUMN wx_prepay_id TEXT",
        "ALTER TABLE payment_records ADD COLUMN wx_code_url TEXT",
        "ALTER TABLE payment_records ADD COLUMN paid_at TEXT",
        "ALTER TABLE payment_records ADD COLUMN notify_ip TEXT",
      ];
      for (const sql of wxMigrations) {
        try { db.run(sql); } catch {}
      }

      // v3.0: sms_log 表（短信发送记录，防刷）
      db.exec(`
        CREATE TABLE IF NOT EXISTS sms_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone TEXT NOT NULL,
          ip TEXT,
          code TEXT NOT NULL,
          sent_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now', '+8 hours'))
        );
        CREATE INDEX IF NOT EXISTS idx_sms_phone ON sms_log(phone);
        CREATE INDEX IF NOT EXISTS idx_sms_ip ON sms_log(ip);
      `);

      // 迁移后必须保存，否则重启后列又丢失
      const savedData = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(savedData));
      return db;
    })();
  }
  return initPromise;
}

// 同步版：返回已初始化的 db（首次调用时触发初始化并同步返回 undefined）
function getDbSync() {
  return db;
}

function run(sql, params = []) {
  if (!db) throw new Error('Database not ready');
  db.run(sql, params);
  saveDb();
  return { changes: db.getRowsModified(), lastInsertRowid: 0 };
}

function get(sql, params = []) {
  if (!db) throw new Error('Database not ready');
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  if (!db) throw new Error('Database not ready');
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function closeDb() {
  if (db) { saveDb(); db.close(); db = null; initPromise = null; }
}

process.on('exit', () => saveDb());
process.on('SIGINT', () => { saveDb(); process.exit(); });
process.on('SIGTERM', () => { saveDb(); process.exit(); });

// async 版：自动等待数据库初始化，适合 async 路由使用
async function getAsync(sql, params = []) {
  await getDb();
  return get(sql, params);
}
async function runAsync(sql, params = []) {
  await getDb();
  return run(sql, params);
}
async function allAsync(sql, params = []) {
  await getDb();
  return all(sql, params);
}

module.exports = { getDb, getDbSync, run, get, all, closeDb, getAsync, runAsync, allAsync };
