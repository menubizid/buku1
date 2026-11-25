/**
 * ============================================================================
 * BUKU WORKSPACE v4.0.0 — GOOGLE APPS SCRIPT REST API (BUKU WORKSPACE EDITION)
 * CMS Kelas Membaca, Smart Reading Tracker & Knowledge Collaboration
 * ============================================================================
 * CHANGELOG v3.0.1 (Hardening):
 *   [SEC]  Rate-limit login & register (CacheService)
 *   [SEC]  Password strength: wajib huruf + angka (8-128 karakter)
 *   [SEC]  Verifikasi enrollment sebelum submit task
 *   [SEC]  Privasi log (IsPublic) di timeline & komentar
 *   [SEC]  Cek akses member pada listClassMembers
 *   [FIX]  bwSafeUrl_ menerima data URI SVG (generator cover frontend)
 *   [FIX]  Username wajib unik (register, saveUser, updateProfile)
 *   [FIX]  bwToggleFriend_ memvalidasi keberadaan target user
 *   [FIX]  bwDeleteLog_ menghitung ulang progress CurrentPage buku
 *   [IMP]  Limit payload doPost (5 MB)
 *   [IMP]  Structured error logging via console.error
 */

const BW_CONFIG = Object.freeze({
  VERSION: '4.0.0',
  DEFAULT_SPREADSHEET_ID: '1jBFonTOZkHlHgRrwe0CMl1Ys41oxM1wddlhlShaCDuo',
  SESSION_TTL_SECONDS: 21600, // 6 Jam
  SCHEMA_CACHE_KEY: 'buku-workspace-schema-v3',
  MAX_PAYLOAD_BYTES: 5 * 1024 * 1024, // 5 MB
  RATE_LIMIT: {
    LOGIN_MAX: 10,     // 10 percobaan
    LOGIN_WINDOW: 900, // per 15 menit
    REGISTER_MAX: 5,   // 5 percobaan
    REGISTER_WINDOW: 3600 // per 1 jam
  },
  TABLES: {
    Users: [
      'UserID', 'Name', 'Username', 'Email', 'PasswordHash', 'PasswordSalt',
      'Role', 'JoinDate', 'AlumniJoinDate', 'WaSettings', 'AvatarURL', 'Bio', 'ResetToken', 'AuthVersion', 'UpdatedAt'
    ],
    Friends: [
      'FriendID', 'UserID', 'FriendUserID', 'Status', 'CreatedAt'
    ],
        ReadingBooks: [
      'BookID', 'UserID', 'Title', 'Author', 'Category', 'TotalPages', 'CurrentPage',
      'CoverURL', 'Topic', 'Status', 'LastReadAt', 'CreatedAt', 'UpdatedAt'
    ],
    ReadingLogs: [
      'LogID', 'UserID', 'BookID', 'ClassID', 'Date', 'StartTime', 'EndTime',
      'BookTitle', 'Author', 'Category', 'TotalBookPages', 'CoverURL',
      'StartPage', 'EndPage', 'PagesRead', 'TotalMinutes', 'EffectiveMinutes',
      'Insight', 'Topic', 'IsPublic', 'CreatedAt', 'UpdatedAt'
    ],
    Comments: [
      'CommentID', 'LogID', 'UserID', 'CommentText', 'CreatedAt'
    ],
    Classes: [
      'ClassID', 'ClassName', 'BatchNumber', 'ClassType', 'Description', 'MentorName',
      'StartDate', 'EndDate', 'CloseDate', 'TargetPagesPerDay', 'MinGradTasks', 'MinGradPages',
      'Status', 'CreatedAt', 'UpdatedAt'
    ],
    ClassMembers: [
      'EnrollmentID', 'ClassID', 'UserID', 'JoinDate', 'BatchPagesRead', 'BatchTasksCompleted',
      'GraduationStatus', 'GraduatedAt', 'MigratedToAlumniAt'
    ],
    Tasks: [
      'TaskID', 'ClassID', 'TaskNumber', 'Title', 'Description', 'ActiveDate', 'Deadline',
      'FormJSON', 'ValidationRuleJSON', 'Status', 'CreatedAt', 'UpdatedAt'
    ],
    UserTasks: [
      'UserTaskID', 'UserID', 'TaskID', 'Status', 'AnswersJSON',
      'Feedback', 'Score', 'SubmittedAt', 'ReviewedAt'
    ]
  }
});

const BW_WRITE_ACTIONS = Object.freeze({
  register: true,
  saveUser: true,
  deleteUser: true,
  saveReadingBook: true,
  deleteReadingBook: true,
  saveLog: true,
  deleteLog: true,
  addComment: true,
  deleteComment: true,
  toggleFriend: true,
  saveClass: true,
  deleteClass: true,
  joinClass: true,
  saveTask: true,
  deleteTask: true,
  submitTask: true,
  reviewSubmission: true,
  updateProfile: true,
  changePassword: true,
  resetPassword: true
});

/**
 * Entry point untuk seluruh request mutasi dan query dari SPA.
 */
function doPost(e) {
  var request;
  try {
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    if (raw.length > BW_CONFIG.MAX_PAYLOAD_BYTES) {
      return bwOutput_(bwResponse_(false, 'Payload permintaan terlalu besar.', null, 'PAYLOAD_TOO_LARGE'));
    }
    request = JSON.parse(raw);
  } catch (error) {
    return bwOutput_(bwResponse_(false, 'Format JSON permintaan tidak valid.', null, 'INVALID_JSON'));
  }
  return bwOutput_(bwHandle_(request));
}

/**
 * Entry point GET untuk pengecekan status server (health) dan katalog publik Landing Page.
 */
function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};
  var action = String(params.action || 'health');
  var response;
  try {
    if (action === 'health') {
      response = bwResponse_(true, 'Buku Workspace API v' + BW_CONFIG.VERSION + ' siap melayani.', {
        version: BW_CONFIG.VERSION,
        status: 'online'
      });
    } else if (action === 'publicCatalog') {
      bwEnsureDatabase_();
      response = bwResponse_(true, 'Katalog bacaan komunitas berhasil dimuat.', bwGetPublicCatalog_());
    } else {
      response = bwResponse_(false, 'Endpoint GET hanya mendukung action health dan publicCatalog.', null, 'METHOD_NOT_ALLOWED');
    }
  } catch (error) {
    response = bwErrorResponse_(error);
  }
  return bwOutput_(response);
}

/**
 * Jalankan fungsi ini sekali dari editor Apps Script untuk menginisialisasi seluruh tabel.
 */
function setupDatabase() {
  CacheService.getScriptCache().remove(BW_CONFIG.SCHEMA_CACHE_KEY);
  bwEnsureDatabase_();
  return 'Database Buku Workspace v' + BW_CONFIG.VERSION + ' siap: ' + Object.keys(BW_CONFIG.TABLES).join(', ');
}

function bwHandle_(request) {
  try {
    if (!request || typeof request !== 'object') {
      throw bwError_('INVALID_REQUEST', 'Format permintaan tidak valid.');
    }
    var action = String(request.action || '').trim();
    if (!action) {
      throw bwError_('MISSING_ACTION', 'Parameter action belum ditentukan.');
    }

    bwEnsureDatabase_();

    if (BW_WRITE_ACTIONS[action]) {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(15000)) {
        throw bwError_('BUSY', 'Server sedang memproses penyimpanan data lain. Silakan coba beberapa detik lagi.');
      }
      try {
        var writeResult = bwRoute_(action, request);
        return bwResponse_(true, writeResult && writeResult._message ? writeResult._message : 'Berhasil disimpan.', bwStripMeta_(writeResult));
      } finally {
        lock.releaseLock();
      }
    }

    var readResult = bwRoute_(action, request);
    return bwResponse_(true, 'Berhasil.', bwStripMeta_(readResult));
  } catch (error) {
    return bwErrorResponse_(error);
  }
}

function bwStripMeta_(data) {
  if (data && typeof data === 'object' && data._message) {
    var copy = Object.assign({}, data);
    delete copy._message;
    return copy;
  }
  return data;
}

function bwRoute_(action, request) {
  var data = request.data && typeof request.data === 'object' ? request.data : {};

  if (action === 'health') return { version: BW_CONFIG.VERSION, status: 'online' };
  if (action === 'publicCatalog') return bwGetPublicCatalog_();
  if (action === 'register') return bwRegister_(data);
  if (action === 'login') return bwLogin_(data);
  if (action === 'logout') return bwLogout_(request);

  var user = bwRequireUser_(request);

  switch (action) {
    case 'getDashboard': return bwGetDashboard_(user);
    case 'exportAllData': return bwExportAllData_(user);
    case 'saveReadingBook': return bwSaveReadingBook_(user, data);
    case 'deleteReadingBook': return bwDeleteReadingBook_(user, data);
    case 'saveLog': return bwSaveLog_(user, data);
    case 'deleteLog': return bwDeleteLog_(user, data);
    case 'getBookTimeline': return bwGetBookTimeline_(user, data);
    case 'addComment': return bwAddComment_(user, data);
    case 'deleteComment': return bwDeleteComment_(user, data);
    case 'toggleFriend': return bwToggleFriend_(user, data);
    case 'listClasses': return bwListClasses_(user);
    case 'saveClass': return bwSaveClass_(user, data);
    case 'deleteClass': return bwDeleteClass_(user, data);
    case 'joinClass': return bwJoinClass_(user, data);
    case 'listClassMembers': return bwListClassMembers_(user, data);
    case 'leaderboard': return bwLeaderboard_(user, data);
    case 'listTasks': return bwListTasks_(user, data);
    case 'saveTask': return bwSaveTask_(user, data);
    case 'deleteTask': return bwDeleteTask_(user, data);
    case 'submitTask': return bwSubmitTask_(user, data);
    case 'listTaskSubmissions': return bwListTaskSubmissions_(user, data);
    case 'reviewSubmission': return bwReviewSubmission_(user, data);
    case 'listUsers': return bwListUsers_(user, data);
    case 'saveUser': return bwSaveUser_(user, data);
    case 'deleteUser': return bwDeleteUser_(user, data);
    case 'getMemberProgress': return bwGetMemberProgress_(user, data);
    case 'getUserBookshelf': return bwGetUserBookshelf_(user, data);
    case 'updateProfile': return bwUpdateProfile_(user, data);
    case 'changePassword': return bwChangePassword_(user, data);
    case 'resetPassword': return bwResetPassword_(data);
    default:
      throw bwError_('UNKNOWN_ACTION', 'Aksi API tidak dikenali: ' + action);
  }
}

/* ==========================================================================
 * RESPONSE & ERROR HELPERS
 * ========================================================================== */

function bwOutput_(response) {
  return ContentService
    .createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

function bwResponse_(success, message, data, code) {
  var payload = {
    success: Boolean(success),
    message: String(message || ''),
    data: data === undefined ? null : data,
    timestamp: new Date().toISOString()
  };
  if (code) payload.code = code;
  return payload;
}

function bwErrorResponse_(error) {
  try {
    console.error('[BW-API] ' + ((error && error.stack) || (error && error.message) || String(error)));
  } catch (e) { /* noop */ }
  var message = error && error.message ? error.message : 'Terjadi kesalahan pada server.';
  var code = error && error.apiCode ? error.apiCode : 'SERVER_ERROR';
  return bwResponse_(false, message, null, code);
}

function bwError_(code, message) {
  var err = new Error(message);
  err.apiCode = code;
  return err;
}

/* ==========================================================================
 * DATABASE INITIALIZATION & BATCH ACCESS LAYER
 * ========================================================================== */

function bwSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPREADSHEET_ID') || BW_CONFIG.DEFAULT_SPREADSHEET_ID;
  if (!id) {
    throw bwError_('CONFIG', 'SPREADSHEET_ID belum diatur pada Script Properties.');
  }
  try {
    return SpreadsheetApp.openById(id);
  } catch (error) {
    throw bwError_('SPREADSHEET_ACCESS', 'Spreadsheet tidak dapat diakses. Pastikan SPREADSHEET_ID benar dan memiliki izin edit.');
  }
}

function bwEnsureDatabase_() {
  var cache = CacheService.getScriptCache();
  if (cache.get(BW_CONFIG.SCHEMA_CACHE_KEY) === 'ready') return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw bwError_('BUSY', 'Sedang memvalidasi struktur database. Coba sesaat lagi.');
  }
  try {
    if (cache.get(BW_CONFIG.SCHEMA_CACHE_KEY) === 'ready') return;
    var ss = bwSpreadsheet_();
    Object.keys(BW_CONFIG.TABLES).forEach(function (tableName) {
      var sheet = ss.getSheetByName(tableName) || ss.insertSheet(tableName);
      var expectedHeaders = BW_CONFIG.TABLES[tableName];
      var lastCol = sheet.getLastColumn();
      var currentHeaders = lastCol > 0
        ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); })
        : [];
      while (currentHeaders.length && !currentHeaders[currentHeaders.length - 1]) {
        currentHeaders.pop();
      }
      if (!currentHeaders.length) {
  sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
  sheet.getRange(1, 1, 1, expectedHeaders.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
} else {
  var missing = expectedHeaders.filter(function (h) { return currentHeaders.indexOf(h) === -1; });
      if (missing.length) {
      sheet.getRange(1, currentHeaders.length + 1, 1, missing.length).setValues([missing]);
      sheet.getRange(1, currentHeaders.length + 1, 1, missing.length).setFontWeight('bold');
    }
    sheet.setFrozenRows(1);
  }
});
    cache.put(BW_CONFIG.SCHEMA_CACHE_KEY, 'ready', 21600);
  } finally {
    lock.releaseLock();
  }
}

function bwReadTables_(tableNames) {
  var ss = bwSpreadsheet_();
  var result = {};
  tableNames.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      result[name] = [];
      return;
    }
    var lastCol = sheet.getLastColumn();
    var lastRow = sheet.getLastRow();
    if (!lastCol || lastRow < 2) {
      result[name] = [];
      return;
    }
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
    var rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    result[name] = rows.filter(function (row) {
      return row.some(function (cell) { return cell !== '' && cell !== null; });
    }).map(function (row) {
      var obj = {};
      headers.forEach(function (header, idx) {
        if (header) obj[header] = bwFormatCell_(row[idx]);
      });
      return obj;
    });
  });
  return result;
}

function bwReadTable_(name) {
  return bwReadTables_([name])[name] || [];
}

function bwFormatCell_(val) {
  if (val instanceof Date) {
    var tz = Session.getScriptTimeZone() || 'Asia/Jakarta';
    var base = Utilities.formatDate(val, tz, "yyyy-MM-dd'T'HH:mm:ss");
    var off  = Utilities.formatDate(val, tz, 'Z'); // contoh: "+0700"
    if (off && /^[+-]\d{4}$/.test(off)) {
      return base + off.slice(0, 3) + ':' + off.slice(3);  // "+07:00"
    }
    return base + '+07:00';  // fallback untuk Asia/Jakarta
  }
  return val;
}

function bwSaveRecord_(tableName, keyField, record) {
  var sheet = bwSpreadsheet_().getSheetByName(tableName);
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var lastRow = sheet.getLastRow();
  var rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];

  var matchIndex = -1;
  var existingObj = {};
  for (var i = 0; i < rows.length; i++) {
    var candidate = {};
    headers.forEach(function (h, idx) { if (h) candidate[h] = bwFormatCell_(rows[i][idx]); });
    if (String(candidate[keyField] || '') === String(record[keyField] || '')) {
      matchIndex = i;
      existingObj = candidate;
      break;
    }
  }

  var merged = Object.assign({}, existingObj, record);
  var outRow = headers.map(function (h) {
    return merged[h] === undefined || merged[h] === null ? '' : merged[h];
  });
  var targetRow = matchIndex >= 0 ? matchIndex + 2 : Math.max(2, lastRow + 1);
  sheet.getRange(targetRow, 1, 1, lastCol).setValues([outRow]);
  return merged;
}

function bwDeleteWhere_(tableName, predicate) {
  var sheet = bwSpreadsheet_().getSheetByName(tableName);
  var lastCol = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();
  if (!lastCol || lastRow < 2) return 0;

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var keepRows = [];
  var deletedCount = 0;

  rows.forEach(function (row) {
    var record = {};
    headers.forEach(function (h, idx) { if (h) record[h] = bwFormatCell_(row[idx]); });
    if (predicate(record)) {
      deletedCount++;
    } else {
      keepRows.push(row);
    }
  });

  if (deletedCount > 0) {
    sheet.getRange(2, 1, rows.length, lastCol).clearContent();
    if (keepRows.length > 0) {
      sheet.getRange(2, 1, keepRows.length, lastCol).setValues(keepRows);
    }
  }
  return deletedCount;
}

/* ==========================================================================
 * UTILITY & SECURITY FUNCTIONS
 * ========================================================================== */

function bwId_(prefix) {
  return prefix + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 18);
}

function bwNow_() {
  return new Date().toISOString();
}

function bwTodayStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyy-MM-dd');
}

function bwClean_(val, maxLen) {
  return String(val === undefined || val === null ? '' : val)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen || 4000);
}

function bwEmail_(val) {
  return bwClean_(val, 180).toLowerCase();
}

function bwUsername_(val, fallbackName) {
  var raw = bwClean_(val || fallbackName || 'pembaca', 40)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
  return raw || 'pembaca';
}

function bwIsTrue_(val) {
  return val === true || String(val).toLowerCase() === 'true' || String(val) === '1';
}

function bwParseJson_(val, fallback) {
  try {
    return typeof val === 'string' ? JSON.parse(val || '') : (val || fallback);
  } catch (e) {
    return fallback;
  }
}

function bwSafeNum_(val, min, max, fallback) {
  var num = Number(val);
  if (!isFinite(num)) num = fallback || 0;
  return Math.max(min, Math.min(max, num));
}

function bwSafeDate_(val) {
  var text = bwClean_(val, 30).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyy-MM-dd');
  }
  return text;
}

/**
 * [FIX v3.0.1] Menerima data URI SVG yang dihasilkan frontend (createSvgCoverDataUri)
 * agar sampul buku komunitas tidak hilang saat sinkronisasi ke Sheets.
 */
function bwSafeUrl_(val) {
  var url = String(val === undefined || val === null ? '' : val).trim();
  if (!url) return '';
  // base64 raster — buang whitespace dulu
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(url)) {
    var compact = url.replace(/\s+/g, '');
    if (compact.length <= 45000) return compact;
    return '';
  }
  // SVG data URI
  if (/^data:image\/svg\+xml(;utf8|;charset=utf-8|;base64)?,/i.test(url) && url.length <= 45000) {
    return url;
  }
  if (/^https:\/\//i.test(url)) return url;
  return '';
}

function bwSalt_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function bwHashPassword_(password, salt) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(salt) + ':' + String(password),
    Utilities.Charset.UTF_8
  );
  return digest.map(function (b) {
    var hex = (b < 0 ? b + 256 : b).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

/**
 * [NEW v3.0.1] Validasi kekuatan password: 8-128 karakter, wajib huruf + angka.
 */
function bwValidatePasswordStrength_(password) {
  var p = String(password || '');
  if (p.length < 8 || p.length > 128) {
    throw bwError_('VALIDATION', 'Kata sandi harus terdiri dari 8 hingga 128 karakter.');
  }
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) {
    throw bwError_('VALIDATION', 'Kata sandi harus mengandung minimal 1 huruf dan 1 angka.');
  }
}

/**
 * [NEW v3.0.1] Rate-limiter sederhana berbasis CacheService (best-effort).
 */
function bwRateLimit_(key, maxAttempts, windowSec) {
  var cache = CacheService.getScriptCache();
  var raw = cache.get(key);
  var now = Date.now();
  var bucket = null;
  if (raw) {
    try { bucket = JSON.parse(raw); } catch (e) { bucket = null; }
  }
  if (!bucket || typeof bucket !== 'object' || typeof bucket.count !== 'number' || typeof bucket.resetAt !== 'number') {
    bucket = { count: 0, resetAt: now + windowSec * 1000 };
  }
  if (now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowSec * 1000 };
  }
  if (bucket.count >= maxAttempts) {
    throw bwError_('RATE_LIMITED', 'Terlalu banyak percobaan. Silakan coba beberapa saat lagi.');
  }
  bucket.count += 1;
  cache.put(key, JSON.stringify(bucket), Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
}

function bwClearRateLimit_(key) {
  try { CacheService.getScriptCache().remove(key); } catch (e) { /* noop */ }
}

/**
 * [NEW v3.0.1] Memastikan username belum dipakai akun lain.
 */
function bwEnsureUniqueUsername_(username, excludeUserId) {
  var clash = bwReadTable_('Users').filter(function (u) {
    return String(u.UserID) !== String(excludeUserId || '') &&
           bwUsername_(u.Username, u.Name) === username;
  })[0];
  if (clash) {
    throw bwError_('USERNAME_TAKEN', 'Username "' + username + '" sudah dipakai. Silakan pilih yang lain.');
  }
}

function bwAdminEmails_() {
  var raw = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS') || '';
  return raw.split(/[;,\s]+/).map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
}

function bwIsConfiguredAdmin_(email) {
  return bwAdminEmails_().indexOf(bwEmail_(email)) >= 0;
}

function bwPublicUser_(u) {
  if (!u) return null;
  var handle = u.Username ? String(u.Username) : bwUsername_('', u.Name);
  return {
    userId: String(u.UserID || ''),
    name: String(u.Name || ''),
    username: handle,
    email: String(u.Email || ''),
    role: String(u.Role || 'Member'),
    joinDate: String(u.JoinDate || ''),
    waSettings: String(u.WaSettings || ''),
    avatarURL: String(u.AvatarURL || ''),
    bio: String(u.Bio || '')
  };
}

function bwNewSession_(user) {
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var payload = {
    userId: String(user.UserID),
    authVersion: String(user.AuthVersion || '1')
  };
  CacheService.getScriptCache().put('bw-sess-v3:' + token, JSON.stringify(payload), BW_CONFIG.SESSION_TTL_SECONDS);
  return { token: token, expiresIn: BW_CONFIG.SESSION_TTL_SECONDS };
}

function bwRequireUser_(request) {
  var token = bwClean_(request && request.token, 200);
  if (!token) throw bwError_('UNAUTHENTICATED', 'Sesi berakhir. Silakan masuk kembali.');
  var raw = CacheService.getScriptCache().get('bw-sess-v3:' + token);
  if (!raw) throw bwError_('SESSION_EXPIRED', 'Sesi telah berakhir. Silakan masuk kembali.');
  var sess = bwParseJson_(raw, null);
  if (!sess || !sess.userId) throw bwError_('SESSION_INVALID', 'Sesi tidak valid.');
  var users = bwReadTable_('Users');
  var user = users.filter(function (u) { return String(u.UserID) === String(sess.userId); })[0];
  if (!user || String(user.AuthVersion || '1') !== String(sess.authVersion || '1')) {
    CacheService.getScriptCache().remove('bw-sess-v3:' + token);
    throw bwError_('SESSION_EXPIRED', 'Sesi akun telah diperbarui. Silakan masuk kembali.');
  }
  return user;
}

function bwRequireAdmin_(user) {
  if (!user || String(user.Role).toLowerCase() !== 'admin') {
    throw bwError_('FORBIDDEN', 'Aksi ini hanya dapat dilakukan oleh Administrator / Mentor.');
  }
}

/* ==========================================================================
 * AUTHENTICATION SERVICES
 * ========================================================================== */

function bwRegister_(data) {
  var name = bwClean_(data.name, 100);
  var email = bwEmail_(data.email);
  var password = String(data.password || '');
  var username = bwUsername_(data.username, name);

  if (name.length < 2) throw bwError_('VALIDATION', 'Nama lengkap minimal 2 karakter.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bwError_('VALIDATION', 'Format email belum valid.');
  bwValidatePasswordStrength_(password);

  // [SEC v3.0.1] Rate-limit percobaan register per email
  bwRateLimit_('rl:reg:' + email, BW_CONFIG.RATE_LIMIT.REGISTER_MAX, BW_CONFIG.RATE_LIMIT.REGISTER_WINDOW);

  var users = bwReadTable_('Users');
  if (users.some(function (u) { return bwEmail_(u.Email) === email; })) {
    throw bwError_('EMAIL_TAKEN', 'Email sudah terdaftar. Silakan langsung masuk.');
  }
  // [FIX v3.0.1] Username wajib unik
  if (users.some(function (u) { return bwUsername_(u.Username, u.Name) === username; })) {
    throw bwError_('USERNAME_TAKEN', 'Username sudah dipakai. Silakan pilih username lain.');
  }

  // Pengguna pertama di spreadsheet atau email yang didaftarkan di ADMIN_EMAILS menjadi Admin
  var isFirstUser = users.length === 0;
  var salt = bwSalt_();
  var now = bwNow_();
  var userRecord = {
    UserID: bwId_('usr'),
    Name: name,
    Username: username,
    Email: email,
    PasswordHash: bwHashPassword_(password, salt),
    PasswordSalt: salt,
    Role: (isFirstUser || bwIsConfiguredAdmin_(email)) ? 'Admin' : 'Member',
    JoinDate: now,
    WaSettings: bwClean_(data.waSettings, 60),
    AvatarURL: bwSafeUrl_(data.avatarURL),
    Bio: bwClean_(data.bio || 'Pembaca aktif di Buku Workspace', 300),
    AuthVersion: '1',
    UpdatedAt: now
  };

  bwSaveRecord_('Users', 'UserID', userRecord);
  bwClearRateLimit_('rl:reg:' + email);
  var sess = bwNewSession_(userRecord);
  return {
    _message: 'Akun berhasil dibuat. Selamat datang di Buku Workspace!',
    user: bwPublicUser_(userRecord),
    token: sess.token,
    expiresIn: sess.expiresIn
  };
}

function bwLogin_(data) {
  var email = bwEmail_(data.email);
  var password = String(data.password || '');

  // ✅ Kunci: pakai identitas user hasil lookup agar tidak bisa diakali
  var users = bwReadTable_('Users');
  var user = users.filter(function (u) {
    return bwEmail_(u.Email) === email || bwUsername_(u.Username, u.Name) === email;
  })[0];

  var rlKey = 'rl:login:' + (user ? 'uid:' + String(user.UserID) : 'ident:' + email);
  bwRateLimit_(rlKey, BW_CONFIG.RATE_LIMIT.LOGIN_MAX, BW_CONFIG.RATE_LIMIT.LOGIN_WINDOW);

  if (!user || bwHashPassword_(password, String(user.PasswordSalt || '')) !== String(user.PasswordHash || '')) {
    throw bwError_('INVALID_CREDENTIALS', 'Email/username atau kata sandi tidak cocok.');
  }

  if (bwIsConfiguredAdmin_(user.Email) && String(user.Role).toLowerCase() !== 'admin') {
    user.Role = 'Admin';
    user.UpdatedAt = bwNow_();
    user = bwSaveRecord_('Users', 'UserID', user);
  }

  bwClearRateLimit_(rlKey);
  var sess = bwNewSession_(user);
  return {
    _message: 'Berhasil masuk.',
    user: bwPublicUser_(user),
    token: sess.token,
    expiresIn: sess.expiresIn
  };
}

function bwLogout_(request) {
  var token = bwClean_(request && request.token, 200);
  if (token) CacheService.getScriptCache().remove('bw-sess-v3:' + token);
  return { loggedOut: true };
}

/* ==========================================================================
 * DASHBOARD, READING BOOKS, SMART TRACKER & SOCIAL SERVICES
 * ========================================================================== */

function bwGetPublicCatalog_() {
  var tables = bwReadTables_(['Users', 'ReadingBooks']);
  var usersById = {};
  tables.Users.forEach(function (u) { usersById[String(u.UserID)] = bwPublicUser_(u); });

  var books = tables.ReadingBooks
    .filter(function (b) {
      return Number(b.CurrentPage || 0) >= 3;
    })
    .sort(function (a, b) {
      return String(b.UpdatedAt || '').localeCompare(String(a.UpdatedAt || ''));
    }).slice(0, 8)
    .map(function (b) {
    var owner = usersById[String(b.UserID)] || { name: 'Pembaca', username: 'pembaca' };
    var total = Math.max(1, Number(b.TotalPages || 100));
    var curr = Math.min(total, Math.max(0, Number(b.CurrentPage || 0)));
    return {
      bookId: String(b.BookID),
      title: String(b.Title || ''),
      author: String(b.Author || 'Penulis'),
      totalPages: total,
      currentPage: curr,
      progressPct: Number(((curr / total) * 100).toFixed(1)),
      coverURL: String(b.CoverURL || ''),
      topic: String(b.Topic || 'Literasi'),
      readerName: owner.name,
      lastReadAt: String(b.LastReadAt || '')
    };
  });

  return { books: books };
}

function bwNormalizeLogForClient_(log, usersById, commentsByLogId) {
  var owner = usersById && usersById[String(log.UserID)]
    ? usersById[String(log.UserID)]
    : { userId: String(log.UserID || ''), name: 'Pembaca', username: 'pembaca', avatarURL: '' };
  var totalBookPages = Math.max(1, Number(log.TotalBookPages || log.EndPage || 100));
  var endPage = Math.max(0, Number(log.EndPage || log.PagesRead || 0));
  var startPage = Math.max(0, Number(log.StartPage || Math.max(1, endPage - Number(log.PagesRead || 0) + 1)));
  var pagesRead = Math.max(1, Number(log.PagesRead || (endPage - startPage + 1) || 1));
  var progressPct = Math.min(100, Number(((endPage / totalBookPages) * 100).toFixed(1)));
  var logComments = (commentsByLogId && commentsByLogId[String(log.LogID)]) ? commentsByLogId[String(log.LogID)] : [];

  return {
    logId: String(log.LogID || ''),
    userId: String(log.UserID || ''),
    userName: owner.name,
    userHandle: owner.username,
    userAvatar: owner.avatarURL,
    bookId: String(log.BookID || ''),
    date: String(log.Date || '').slice(0, 10),
    startTime: String(log.StartTime || ''),
    endTime: String(log.EndTime || ''),
    bookTitle: String(log.BookTitle || 'Buku Bacaan'),
    author: String(log.Author || 'Penulis'),
    totalBookPages: totalBookPages,
    coverURL: String(log.CoverURL || ''),
    startPage: startPage,
    endPage: endPage,
    pagesRead: pagesRead,
    progressPct: progressPct,
    totalMinutes: Number(log.TotalMinutes || 0),
    effectiveMinutes: Number(log.EffectiveMinutes || 0),
    insight: String(log.Insight || ''),
    topic: String(log.Topic || 'umum'),
    isPublic: (log.IsPublic === undefined || log.IsPublic === null || log.IsPublic === '')
  ? true
  : bwIsTrue_(log.IsPublic),
    commentsCount: logComments.length,
    comments: logComments,
    createdAt: String(log.CreatedAt || ''),
    updatedAt: String(log.UpdatedAt || '')
  };
}

function bwNormalizeBookForClient_(book, usersById) {
  var owner = usersById && usersById[String(book.UserID)]
    ? usersById[String(book.UserID)]
    : { userId: String(book.UserID || ''), name: 'Pembaca', username: 'pembaca' };
  var totalPages = Math.max(1, Number(book.TotalPages || 100));
  var currentPage = Math.min(totalPages, Math.max(0, Number(book.CurrentPage || 0)));
  var pct = Math.min(100, Number(((currentPage / totalPages) * 100).toFixed(1)));
  var status = currentPage >= totalPages ? 'Finished' : (book.Status || 'Reading');
  return {
    bookId: String(book.BookID || ''),
    userId: String(book.UserID || ''),
    readerName: owner.name,
    readerHandle: owner.username,
    title: String(book.Title || ''),
    author: String(book.Author || 'Penulis'),
    totalPages: totalPages,
    currentPage: currentPage,
    progressPct: pct,
    coverURL: String(book.CoverURL || ''),
    topic: String(book.Topic || 'umum'),
    status: status,
    lastReadAt: String(book.LastReadAt || ''),
    createdAt: String(book.CreatedAt || ''),
    updatedAt: String(book.UpdatedAt || '')
    // isPublic DIHAPUS
  };
}

function bwGetDashboard_(user) {
  var tables = bwReadTables_([
    'Users', 'Friends', 'ReadingBooks', 'ReadingLogs',
    'Comments', 'Classes', 'ClassMembers', 'Tasks', 'UserTasks'
  ]);

  var usersById = {};
  tables.Users.forEach(function (u) { usersById[String(u.UserID)] = bwPublicUser_(u); });

  var commentsByLogId = {};
  tables.Comments.forEach(function (c) {
    var lid = String(c.LogID || '');
    if (!commentsByLogId[lid]) commentsByLogId[lid] = [];
    var commenter = usersById[String(c.UserID)] || { name: 'Pembaca', username: 'pembaca', avatarURL: '' };
    commentsByLogId[lid].push({
      commentId: String(c.CommentID || ''),
      logId: lid,
      userId: String(c.UserID || ''),
      userName: commenter.name,
      userHandle: commenter.username,
      userAvatar: commenter.avatarURL,
      commentText: String(c.CommentText || ''),
      createdAt: String(c.CreatedAt || '')
    });
  });

  var allLogs = tables.ReadingLogs.map(function (l) {
    return bwNormalizeLogForClient_(l, usersById, commentsByLogId);
  }).sort(function (a, b) {
    return String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date));
  });

  var myLogs = allLogs.filter(function (l) { return l.userId === String(user.UserID); });
  // di bwGetDashboard_
var isAdminUser = String(user.Role).toLowerCase() === 'admin';

var communityLogs = allLogs.filter(function (l) {
  return l.isPublic || l.userId === String(user.UserID) || isAdminUser;
}).slice(0, 150);

  var allBooks = tables.ReadingBooks.map(function (b) {
    return bwNormalizeBookForClient_(b, usersById);
  }).sort(function (a, b) {
    return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
  });

  var myBooks = allBooks.filter(function (b) { return b.userId === String(user.UserID); });

  var friendIds = {};
  tables.Friends.forEach(function (f) {
    if (String(f.UserID) === String(user.UserID) && String(f.Status) !== 'Rejected') {
      friendIds[String(f.FriendUserID)] = String(f.Status || 'Accepted');
    } else if (String(f.FriendUserID) === String(user.UserID) && String(f.Status) !== 'Rejected') {
      friendIds[String(f.UserID)] = String(f.Status || 'Accepted');
    }
  });

  var directory = tables.Users.map(function (u) {
    var pub = bwPublicUser_(u);
    var uid = pub.userId;
    var uLogs = allLogs.filter(function (l) {
      return l.userId === uid &&
             (l.isPublic || uid === String(user.UserID) || isAdminUser);
    });
    var uBooks = allBooks.filter(function (b) { return b.userId === uid; });
    return {
      userId: uid,
      name: pub.name,
      username: pub.username,
      role: pub.role,
      avatarURL: pub.avatarURL,
      bio: pub.bio,
      isFriend: Boolean(friendIds[uid]),
      booksCount: uBooks.length,
      logsCount: uLogs.length,
      pagesRead: uLogs.reduce(function (s, l) { return s + Number(l.pagesRead || 0); }, 0)
    };
  });

  var myClassIds = tables.ClassMembers
    .filter(function (cm) { return String(cm.UserID) === String(user.UserID); })
    .map(function (cm) { return String(cm.ClassID); });

  var classes = tables.Classes.map(function (cls) {
    var cid = String(cls.ClassID || '');
    return {
      classId: cid,
      className: String(cls.ClassName || ''),
      description: String(cls.Description || ''),
      mentorName: String(cls.MentorName || 'Mentor Literasi'),
      targetPagesPerDay: Number(cls.TargetPagesPerDay || 10),
      status: String(cls.Status || 'Active'),
      membersCount: tables.ClassMembers.filter(function (m) { return String(m.ClassID) === cid; }).length,
      joined: myClassIds.indexOf(cid) >= 0,
      createdAt: String(cls.CreatedAt || '')
    };
  });

  var tasks = tables.Tasks.filter(function (t) {
    return isAdminUser || (myClassIds.indexOf(String(t.ClassID)) >= 0 && String(t.Status) !== 'Draft');
  }).map(function (t) {
    var cls = classes.filter(function (c) { return c.classId === String(t.ClassID); })[0];
    var sub = tables.UserTasks.filter(function (ut) {
      return String(ut.TaskID) === String(t.TaskID) && String(ut.UserID) === String(user.UserID);
    })[0] || null;
    return bwTaskForClient_(t, sub, cls, tables.UserTasks);
  });

  return {
  user: bwPublicUser_(user),
  myBooks: myBooks,
  communityBooks: allBooks.slice(0, 120),
  myLogs: myLogs,
  communityLogs: communityLogs,
  people: directory,
  classes: classes,
  tasks: tasks,
  users: isAdminUser ? tables.Users.map(bwPublicUser_) : [],
  // ✅ tambahan
  friends: tables.Friends
    .filter(function (f) { return String(f.Status) !== 'Rejected'; })
    .map(function (f) { return {
    friendId: String(f.FriendID), userId: String(f.UserID),
    friendUserId: String(f.FriendUserID), status: String(f.Status)
  }; }),
  classMembers: tables.ClassMembers.map(function (m) { return {
    enrollmentId: String(m.EnrollmentID), classId: String(m.ClassID),
    userId: String(m.UserID), joinDate: String(m.JoinDate)
  }; }),
  userTasks: tables.UserTasks
    .filter(function (ut) { return String(ut.UserID) === String(user.UserID); })
    .map(function (ut) { return {
      userTaskId: String(ut.UserTaskID), userId: String(ut.UserID),
      taskId: String(ut.TaskID), status: String(ut.Status),
      answers: bwParseJson_(ut.AnswersJSON, {}),
      feedback: String(ut.Feedback || ''),
      score: (ut.Score === '' || ut.Score === null || ut.Score === undefined) ? null : Number(ut.Score),
      submittedAt: String(ut.SubmittedAt || '')
    }; })
  };
}

function bwSaveReadingBook_(user, data) {
  var bookId = bwClean_(data.bookId, 100) || bwId_('bk');
  var books = bwReadTable_('ReadingBooks');
  var existing = books.filter(function (b) { return String(b.BookID) === bookId; })[0] || null;

  if (existing && String(existing.UserID) !== String(user.UserID) && String(user.Role).toLowerCase() !== 'admin') {
    throw bwError_('FORBIDDEN', 'Anda tidak dapat mengubah buku milik pengguna lain.');
  }

  var title = bwClean_(data.title, 180);
  var author = bwClean_(data.author, 140);
  if (title.length < 2) throw bwError_('VALIDATION', 'Judul buku minimal 2 karakter.');
  if (author.length < 2) throw bwError_('VALIDATION', 'Nama penulis buku wajib diisi.');

  var totalPages = Math.round(bwSafeNum_(data.totalPages, 1, 50000, 200));
  var currentPage = Math.round(bwSafeNum_(data.currentPage, 0, totalPages, existing ? Number(existing.CurrentPage || 0) : 0));
  var now = bwNow_();

var sanitizedCover = bwSafeUrl_(data.coverURL !== undefined ? data.coverURL : '');
if (!sanitizedCover && existing) {
  sanitizedCover = bwSafeUrl_(existing.CoverURL);
}

  var record = {
    BookID: bookId,
    UserID: existing ? String(existing.UserID) : String(user.UserID),
    Title: title,
    Author: author,
    TotalPages: totalPages,
    CurrentPage: currentPage,
    CoverURL: sanitizedCover,
    Topic: bwClean_(data.topic || (existing ? existing.Topic : 'literasi'), 120),
    Status: currentPage >= totalPages ? 'Finished' : 'Reading',
    LastReadAt: existing ? String(existing.LastReadAt || '') : '',
    CreatedAt: existing ? String(existing.CreatedAt || now) : now,
    UpdatedAt: now
    // IsPublic DIHAPUS
  };

  bwSaveRecord_('ReadingBooks', 'BookID', record);
  return {
    _message: 'Buku bacaan berhasil disimpan.',
    book: bwNormalizeBookForClient_(record, null)
  };
}

function bwDeleteReadingBook_(user, data) {
  var bookId = bwClean_(data.bookId, 100);
  var books = bwReadTable_('ReadingBooks');
  var book = books.filter(function (b) { return String(b.BookID) === bookId; })[0];
  if (!book) throw bwError_('NOT_FOUND', 'Buku bacaan tidak ditemukan.');
  if (String(book.UserID) !== String(user.UserID) && String(user.Role).toLowerCase() !== 'admin') {
    throw bwError_('FORBIDDEN', 'Anda tidak memiliki izin menghapus buku ini.');
  }

  // Cascade delete: komentar → log → buku
  var relatedLogIds = bwReadTable_('ReadingLogs')
    .filter(function (l) { return String(l.BookID) === bookId; })
    .map(function (l) { return String(l.LogID); });

  if (relatedLogIds.length) {
    bwDeleteWhere_('Comments', function (c) {
      return relatedLogIds.indexOf(String(c.LogID)) >= 0;
    });
    bwDeleteWhere_('ReadingLogs', function (l) {
      return relatedLogIds.indexOf(String(l.LogID)) >= 0;
    });
  }
  bwDeleteWhere_('ReadingBooks', function (b) { return String(b.BookID) === bookId; });

  return {
    _message: 'Buku beserta ' + relatedLogIds.length + ' log terkait berhasil dihapus.',
    deleted: true,
    removedLogs: relatedLogIds.length
  };
}

function bwSaveLog_(user, data) {
  var logId = bwClean_(data.logId, 100) || bwId_('log');
  var existing = bwReadTable_('ReadingLogs').filter(function (l) {
  return String(l.LogID) === logId;
})[0] || null;

  if (existing && String(existing.UserID) !== String(user.UserID) && String(user.Role).toLowerCase() !== 'admin') {
    throw bwError_('FORBIDDEN', 'Anda tidak dapat mengubah catatan baca milik pengguna lain.');
  }

  var bookTitle = bwClean_(data.bookTitle, 180);
  var author = bwClean_(data.author, 140);
  if (bookTitle.length < 2) throw bwError_('VALIDATION', 'Judul buku wajib diisi.');
  if (author.length < 2) throw bwError_('VALIDATION', 'Nama penulis buku wajib diisi.');

  var startPage = Math.round(bwSafeNum_(data.startPage, 1, 50000, 1));
  var endPage = Math.round(bwSafeNum_(data.endPage, startPage, 50000, startPage));
  var pagesRead = Math.max(1, endPage - startPage + 1);
  var totalBookPages = Math.round(bwSafeNum_(data.totalBookPages, endPage, 50000, Math.max(endPage, 200)));

  var totalMinutes = Math.round(bwSafeNum_(data.totalMinutes, 1, 1440, 1));
  var effectiveMinutes = Math.round(bwSafeNum_(data.effectiveMinutes, 1, totalMinutes, totalMinutes));

  var insight = bwClean_(data.insight, 3000);
  if (insight.length < 3) {
    throw bwError_('VALIDATION', 'Kesimpulan / insight bacaan wajib diisi.');
  }

  var topic = bwClean_(data.topic || 'literasi', 120);
  var dateStr = bwSafeDate_(data.date);
  var ownerId = existing ? String(existing.UserID) : String(user.UserID);

  // Sinkronkan dengan tabel ReadingBooks agar progress kartu buku di Beranda terupdate otomatis
var books = bwReadTable_('ReadingBooks');
var bookId = bwClean_(data.bookId, 100);
var matchedBook = null;
if (bookId) {
  matchedBook = books.filter(function (b) {
    return String(b.BookID) === bookId && String(b.UserID) === ownerId;
  })[0] || null;
}
if (!matchedBook) {
  matchedBook = books.filter(function (b) {
    return String(b.UserID) === ownerId &&
           String(b.Title || '').toLowerCase() === bookTitle.toLowerCase();
  })[0] || null;
}

// ✅ Tolak jika bookId yang dikirim jelas milik user lain
if (bookId && !matchedBook) {
  var wrongBook = books.filter(function (b) { return String(b.BookID) === bookId; })[0];
  if (wrongBook && String(wrongBook.UserID) !== ownerId) {
    throw bwError_('FORBIDDEN', 'Buku yang dipilih bukan milik pembaca ini.');
  }
}

var finalBookId = matchedBook ? String(matchedBook.BookID) : (bookId || bwId_('bk'));
var finalTotalPages = matchedBook
  ? Math.max(Number(matchedBook.TotalPages || 0), totalBookPages)
  : totalBookPages;
var finalCover = bwSafeUrl_(data.coverURL);
if (!finalCover) {
  finalCover = matchedBook ? bwSafeUrl_(matchedBook.CoverURL) : '';
}
var nowWrite = bwNow_();

// ✅ Bangun record buku dasar (CurrentPage akan direkalkulasi setelah log disimpan)
var bookRecord = {
    BookID: finalBookId,
    UserID: ownerId,
    Title: bookTitle,
    Author: author,
    TotalPages: finalTotalPages,
    CurrentPage: matchedBook ? Number(matchedBook.CurrentPage || 0) : 0,
    CoverURL: finalCover,
    Topic: topic,
    Status: matchedBook ? String(matchedBook.Status || 'Reading') : 'Reading',
    LastReadAt: nowWrite,
    CreatedAt: matchedBook ? String(matchedBook.CreatedAt || nowWrite) : nowWrite,
    UpdatedAt: nowWrite
    // IsPublic DIHAPUS — buku selalu publik
  };

// ========= Simpan LOG DULU =========
var logRecord = {
  LogID: logId,
  UserID: ownerId,
  BookID: finalBookId,
  Date: dateStr,
  StartTime: bwClean_(data.startTime || '', 40),
  EndTime: bwClean_(data.endTime || '', 40),
  BookTitle: bookTitle,
  Author: author,
  TotalBookPages: finalTotalPages,
  CoverURL: finalCover,
  StartPage: startPage,
  EndPage: endPage,
  PagesRead: pagesRead,
  TotalMinutes: totalMinutes,
  EffectiveMinutes: effectiveMinutes,
  Insight: insight,
  Topic: topic,
  IsPublic: data.isPublic === undefined ? true : bwIsTrue_(data.isPublic),
  CreatedAt: existing ? String(existing.CreatedAt || nowWrite) : nowWrite,
  UpdatedAt: nowWrite
};
bwSaveRecord_('ReadingLogs', 'LogID', logRecord);

// ✅ Rekalkulasi buku LAMA jika log dipindahkan ke buku lain
if (existing && String(existing.BookID) !== String(finalBookId)) {
  var oldBook = bwReadTable_('ReadingBooks').filter(function (b) {
    return String(b.BookID) === String(existing.BookID);
  })[0];
  if (oldBook) {
    var sisaLog = bwReadTable_('ReadingLogs').filter(function (l) {
      return String(l.BookID) === String(existing.BookID);
    });
    var oldMaxPage = sisaLog.reduce(function (mx, l) {
      return Math.max(mx, Number(l.EndPage || 0));
    }, 0);
    oldBook.CurrentPage = Math.min(Number(oldBook.TotalPages || 1), oldMaxPage);
    oldBook.Status = oldBook.CurrentPage >= Number(oldBook.TotalPages || 1) ? 'Finished' : 'Reading';
    oldBook.UpdatedAt = bwNow_();
    bwSaveRecord_('ReadingBooks', 'BookID', oldBook);
  }
}

// ✅ Rekalkulasi CurrentPage buku dari SEMUA log (termasuk log yang baru disimpan)
var allLogsForBook = bwReadTable_('ReadingLogs').filter(function (l) {
  return String(l.BookID) === finalBookId && String(l.UserID) === ownerId;
});
var computedMaxPage = allLogsForBook.reduce(function (mx, l) {
  return Math.max(mx, Number(l.EndPage || 0));
}, 0);

bookRecord.CurrentPage = Math.min(bookRecord.TotalPages, computedMaxPage);
bookRecord.Status = bookRecord.CurrentPage >= bookRecord.TotalPages ? 'Finished' : 'Reading';
bookRecord.UpdatedAt = bwNow_();

  // ✅ Satu-satunya penulisan ke ReadingBooks
  bwSaveRecord_('ReadingBooks', 'BookID', bookRecord);

  return {
    _message: 'Catatan membaca dan kesimpulan berhasil disimpan!',
    log: bwNormalizeLogForClient_(logRecord, null, {}),
    book: bwNormalizeBookForClient_(bookRecord, null)
  };
}

/**
 * [FIX v3.0.1] Setelah log dihapus, hitung ulang CurrentPage buku
 * jika log yang dihapus memang yang menjadi penentu progress terakhirnya.
 */
function bwDeleteLog_(user, data) {
  var logId = bwClean_(data.logId, 100);
  var logs = bwReadTable_('ReadingLogs');
  var target = logs.filter(function (l) { return String(l.LogID) === logId; })[0];
  if (!target) throw bwError_('NOT_FOUND', 'Catatan baca tidak ditemukan.');
  if (String(target.UserID) !== String(user.UserID) && String(user.Role).toLowerCase() !== 'admin') {
    throw bwError_('FORBIDDEN', 'Anda tidak memiliki akses menghapus catatan ini.');
  }

  bwDeleteWhere_('Comments', function (c) { return String(c.LogID) === logId; });
  bwDeleteWhere_('ReadingLogs', function (l) { return String(l.LogID) === logId; });

  // Recalculate book progress
  var remainingLogs = bwReadTable_('ReadingLogs').filter(function (l) {
    return String(l.BookID) === String(target.BookID);
  });
  var book = bwReadTable_('ReadingBooks').filter(function (b) {
    return String(b.BookID) === String(target.BookID);
  })[0];

  if (book && Number(book.CurrentPage) === Number(target.EndPage)) {
    var maxPage = remainingLogs.reduce(function (mx, l) {
      return Math.max(mx, Number(l.EndPage || 0));
    }, 0);
    book.CurrentPage = maxPage;
    book.Status = maxPage >= Number(book.TotalPages || 1) ? 'Finished' : 'Reading';
    book.UpdatedAt = bwNow_();
    bwSaveRecord_('ReadingBooks', 'BookID', book);
  }

  return { _message: 'Catatan membaca dihapus.', deleted: true };
}

/**
 * [FIX v3.0.1] Timeline hanya menampilkan log publik, milik sendiri,
 * atau seluruhnya jika user adalah admin.
 */
function bwGetBookTimeline_(user, data) {
  var tables = bwReadTables_(['Users', 'ReadingBooks', 'ReadingLogs', 'Comments']);
  var usersById = {};
  tables.Users.forEach(function (u) { usersById[String(u.UserID)] = bwPublicUser_(u); });

    var commentsByLogId = {};
  tables.Comments.forEach(function (c) {
    var lid = String(c.LogID || '');
    if (!commentsByLogId[lid]) commentsByLogId[lid] = [];
    var author = usersById[String(c.UserID)] || { name: 'Pembaca', username: 'pembaca', avatarURL: '' };
    commentsByLogId[lid].push({
      commentId: String(c.CommentID || ''),
      logId: lid,
      userId: String(c.UserID || ''),
      userName: author.name,
      userHandle: author.username,
      userAvatar: author.avatarURL,
      commentText: String(c.CommentText || ''),
      createdAt: String(c.CreatedAt || '')
    });
  });

  var isAdmin = String(user.Role).toLowerCase() === 'admin';
var visibleLogs = tables.ReadingLogs.filter(function (rl) {
  var isPublic = (rl.IsPublic === undefined || rl.IsPublic === null || rl.IsPublic === '')
    ? true
    : bwIsTrue_(rl.IsPublic);
  return isPublic || String(rl.UserID) === String(user.UserID) || isAdmin;
});

  var bookId = bwClean_(data.bookId, 100);
  var logId  = bwClean_(data.logId, 100);

  var allLogs = visibleLogs.map(function (l) {
    return bwNormalizeLogForClient_(l, usersById, commentsByLogId);
  });

  var primaryLog = logId ? allLogs.filter(function (l) { return l.logId === logId; })[0] : null;
  var targetBookId = bookId || (primaryLog ? primaryLog.bookId : '');

  // ✅ bookRow dihitung SETELAH targetBookId tersedia
    // GANTI bookRow (satu blok penuh):
  var bookRow = tables.ReadingBooks.filter(function (b) {
    return String(b.BookID) === targetBookId;
  })[0] || null;

  var timeline = allLogs.filter(function (l) {
    if (targetBookId && l.bookId === targetBookId) return true;
    if (primaryLog && l.bookTitle.toLowerCase() === primaryLog.bookTitle.toLowerCase()
        && l.userId === primaryLog.userId) return true;
    return false;
  }).sort(function (a, b) {
    return String(b.createdAt || b.date).localeCompare(String(a.createdAt || a.date));
  });

  return {
    book: bookRow ? bwNormalizeBookForClient_(bookRow, usersById) : null,
    latestLog: primaryLog || timeline[0] || null,
    timeline: timeline
  };
}

/**
 * [FIX v3.0.1] Cek IsPublic sebelum menambahkan komentar.
 */
function bwAddComment_(user, data) {
  var logId = bwClean_(data.logId, 100);
  var commentText = bwClean_(data.commentText, 1200);
  if (!logId) throw bwError_('VALIDATION', 'ID catatan baca tidak ditemukan.');
  if (commentText.length < 2) throw bwError_('VALIDATION', 'Tulis komentar minimal 2 karakter.');

  var log = bwReadTable_('ReadingLogs').filter(function (l) { return String(l.LogID) === logId; })[0];
  if (!log) throw bwError_('NOT_FOUND', 'Catatan baca yang dikomentari tidak ditemukan.');

  var isPublic = (log.IsPublic === undefined || log.IsPublic === null || log.IsPublic === '')
  ? true
  : bwIsTrue_(log.IsPublic);
  var isOwner = String(log.UserID) === String(user.UserID);
  var isAdmin = String(user.Role).toLowerCase() === 'admin';
  if (!isPublic && !isOwner && !isAdmin) {
    throw bwError_('FORBIDDEN', 'Catatan baca ini bersifat privat dan tidak dapat dikomentari.');
  }

  var record = {
    CommentID: bwId_('cmt'),
    LogID: logId,
    UserID: String(user.UserID),
    CommentText: commentText,
    CreatedAt: bwNow_()
  };
  bwSaveRecord_('Comments', 'CommentID', record);
  var pub = bwPublicUser_(user);
  return {
    _message: 'Komentar berhasil dikirim.',
    comment: {
      commentId: record.CommentID,
      logId: record.LogID,
      userId: pub.userId,
      userName: pub.name,
      userHandle: pub.username,
      userAvatar: pub.avatarURL,
      commentText: record.CommentText,
      createdAt: record.CreatedAt
    }
  };
}

function bwDeleteComment_(user, data) {
  var commentId = bwClean_(data.commentId, 100);
  var comments = bwReadTable_('Comments');
  var target = comments.filter(function (c) { return String(c.CommentID) === commentId; })[0];
  if (!target) throw bwError_('NOT_FOUND', 'Komentar tidak ditemukan.');
  if (String(target.UserID) !== String(user.UserID) && String(user.Role).toLowerCase() !== 'admin') {
    throw bwError_('FORBIDDEN', 'Anda tidak dapat menghapus komentar pengguna lain.');
  }
  bwDeleteWhere_('Comments', function (c) { return String(c.CommentID) === commentId; });
  return { _message: 'Komentar dihapus.', deleted: true };
}

/**
 * [FIX v3.0.1] Verifikasi keberadaan target user sebelum toggle friend.
 */
function bwToggleFriend_(user, data) {
  var friendUserId = bwClean_(data.friendUserId, 100);
  if (!friendUserId || friendUserId === String(user.UserID)) {
    throw bwError_('VALIDATION', 'Pilih pengguna lain untuk dijadikan teman membaca.');
  }

  var targetExists = bwReadTable_('Users').some(function (u) {
    return String(u.UserID) === friendUserId;
  });
  if (!targetExists) {
    throw bwError_('NOT_FOUND', 'Pengguna yang ingin dijadikan teman tidak ditemukan.');
  }

  var friends = bwReadTable_('Friends');
  var existing = friends.filter(function (f) {
    return (String(f.UserID) === String(user.UserID) && String(f.FriendUserID) === friendUserId) ||
           (String(f.UserID) === friendUserId && String(f.FriendUserID) === String(user.UserID));
  })[0];

  if (existing) {
    bwDeleteWhere_('Friends', function (f) {
  return (String(f.UserID) === String(user.UserID) && String(f.FriendUserID) === friendUserId) ||
         (String(f.UserID) === friendUserId && String(f.FriendUserID) === String(user.UserID));
});
    return { _message: 'Pertemanan dilepaskan.', isFriend: false, friendUserId: friendUserId };
  }

  var record = {
    FriendID: bwId_('frd'),
    UserID: String(user.UserID),
    FriendUserID: friendUserId,
    Status: 'Accepted',
    CreatedAt: bwNow_()
  };
  bwSaveRecord_('Friends', 'FriendID', record);
  return { _message: 'Berhasil berteman! Aktivitas membacanya kini tampil di feed Anda.', isFriend: true, friendUserId: friendUserId };
}

/* ==========================================================================
 * READING CLASSES, DYNAMIC FORM TASKS & LEADERBOARD
 * ========================================================================== */

function bwListClasses_(user) {
  var tables = bwReadTables_(['Classes', 'ClassMembers']);
  var myClassIds = tables.ClassMembers
    .filter(function (m) { return String(m.UserID) === String(user.UserID); })
    .map(function (m) { return String(m.ClassID); });

  var classes = tables.Classes.map(function (cls) {
    var cid = String(cls.ClassID || '');
    return {
      classId: cid,
      className: String(cls.ClassName || ''),
      batchNumber: Number(cls.BatchNumber || 0),
      classType: String(cls.ClassType || 'Batch'),
      description: String(cls.Description || ''),
      mentorName: String(cls.MentorName || 'Mentor'),
      startDate: String(cls.StartDate || ''),
      endDate: String(cls.EndDate || ''),
      closeDate: String(cls.CloseDate || ''),
      targetPagesPerDay: Number(cls.TargetPagesPerDay || 35),
      minGradTasks: Number(cls.MinGradTasks || 6),
      minGradPages: Number(cls.MinGradPages || 1000),
      status: String(cls.Status || 'Active'),
      membersCount: tables.ClassMembers.filter(function (m) { return String(m.ClassID) === cid; }).length,
      joined: myClassIds.indexOf(cid) >= 0,
      createdAt: String(cls.CreatedAt || ''),
      updatedAt: String(cls.UpdatedAt || '')
    };
  });
  return { classes: classes };
}

function bwSaveClass_(user, data) {
  bwRequireAdmin_(user);
  var classId = bwClean_(data.classId, 100) || bwId_('cls');
  var className = bwClean_(data.className, 140);
  if (className.length < 3) throw bwError_('VALIDATION', 'Nama kelas minimal 3 karakter.');

  var existing = bwReadTable_('Classes').filter(function (c) { return String(c.ClassID) === classId; })[0];
  var now = bwNow_();
  var startDate = data.startDate ? bwSafeDate_(data.startDate) : (existing ? String(existing.StartDate||'') : '');
  var endDate = data.endDate ? bwSafeDate_(data.endDate) : (existing ? String(existing.EndDate||'') : '');
  var closeDate = data.closeDate ? bwSafeDate_(data.closeDate) : (existing ? String(existing.CloseDate||'') : '');
  var record = {
    ClassID: classId,
    ClassName: className,
    BatchNumber: Math.round(bwSafeNum_(data.batchNumber, 0, 9999, Number(existing && existing.BatchNumber || 0))),
    ClassType: String(data.classType || (existing && existing.ClassType) || 'Batch') === 'Alumni' ? 'Alumni' : 'Batch',
    Description: bwClean_(data.description, 2000),
    MentorName: bwClean_(data.mentorName || (existing ? existing.MentorName : '') || user.Name || 'Mentor', 100),
    StartDate: startDate,
    EndDate: endDate,
    CloseDate: closeDate,
    TargetPagesPerDay: Math.round(bwSafeNum_(data.targetPagesPerDay, 1, 500, 35)),
    MinGradTasks: Math.round(bwSafeNum_(data.minGradTasks, 0, 100, 6)),
    MinGradPages: Math.round(bwSafeNum_(data.minGradPages, 0, 100000, 1000)),
    Status: data.status === 'Closed' ? 'Closed' : 'Active',
    CreatedAt: existing ? String(existing.CreatedAt || now) : now,
    UpdatedAt: now
  };
  bwSaveRecord_('Classes', 'ClassID', record);
  return { _message: 'Kelas berhasil disimpan.', classItem: record };
}

function bwDeleteClass_(user, data) {
  bwRequireAdmin_(user);
  var classId = bwClean_(data.classId, 100);
  var taskIds = bwReadTable_('Tasks')
    .filter(function (t) { return String(t.ClassID) === classId; })
    .map(function (t) { return String(t.TaskID); });

  bwDeleteWhere_('UserTasks', function (ut) { return taskIds.indexOf(String(ut.TaskID)) >= 0; });
  bwDeleteWhere_('Tasks', function (t) { return String(t.ClassID) === classId; });
  bwDeleteWhere_('ClassMembers', function (cm) { return String(cm.ClassID) === classId; });
  bwDeleteWhere_('Classes', function (c) { return String(c.ClassID) === classId; });
  return { _message: 'Kelas membaca dan tugas terkait telah dihapus.', deleted: true };
}

function bwJoinClass_(user, data) {
  var classId = bwClean_(data.classId, 100);
  var cls = bwReadTable_('Classes').filter(function (c) { return String(c.ClassID) === classId; })[0];
  if (!cls) throw bwError_('NOT_FOUND', 'Kelas tidak ditemukan.');
  var today = bwTodayStr_();
  var closeDate = String(cls.CloseDate || '').slice(0,10);
  if (String(cls.Status) === 'Closed' || (closeDate && today >= closeDate)) {
    throw bwError_('CLOSED', 'Kelas sudah ditutup. Pendaftaran peserta baru tidak tersedia.');
  }
  if (String(cls.ClassType || '') === 'Alumni') {
    throw bwError_('FORBIDDEN', 'Pendaftaran ke Kelas Alumni dilakukan otomatis.');
  }
  var members = bwReadTable_('ClassMembers');
  var already = members.some(function (m) {
    return String(m.ClassID) === classId && String(m.UserID) === String(user.UserID);
  });
  if (!already) {
    bwSaveRecord_('ClassMembers', 'EnrollmentID', {
      EnrollmentID: bwId_('enr'),
      ClassID: classId,
      UserID: String(user.UserID),
      JoinDate: bwNow_(),
      BatchPagesRead: 0,
      BatchTasksCompleted: 0,
      GraduationStatus: 'InProgress',
      GraduatedAt: '',
      MigratedToAlumniAt: ''
    });
  }
  return { _message: 'Berhasil bergabung ke kelas!', joined: true };
}

/**
 * [FIX v3.0.1] Hanya admin atau anggota kelas yang boleh melihat daftar peserta.
 */
function bwListClassMembers_(user, data) {
  var classId = bwClean_(data.classId, 100);
  var tables = bwReadTables_(['Classes', 'ClassMembers', 'Users']);
  var cls = tables.Classes.filter(function (c) { return String(c.ClassID) === classId; })[0];
  if (!cls) throw bwError_('NOT_FOUND', 'Kelas tidak ditemukan.');

  var isAdmin = String(user.Role).toLowerCase() === 'admin';
  var isMember = tables.ClassMembers.some(function (m) {
    return String(m.ClassID) === classId && String(m.UserID) === String(user.UserID);
  });
  if (!isAdmin && !isMember) {
    throw bwError_('FORBIDDEN', 'Anda bukan anggota kelas ini.');
  }

  var enrollments = tables.ClassMembers.filter(function (m) { return String(m.ClassID) === classId; });
  var members = enrollments.map(function (m) {
    var person = tables.Users.filter(function (u) { return String(u.UserID) === String(m.UserID); })[0];
    if (!person) return null;
    var pub = bwPublicUser_(person);
    pub.enrollmentDate = String(m.JoinDate || '');
    return pub;
  }).filter(Boolean);

  return {
    classItem: {
      classId: String(cls.ClassID),
      className: String(cls.ClassName),
      mentorName: String(cls.MentorName || '')
    },
    members: members
  };
}

function bwLeaderboard_(user, data) {
  var classId = bwClean_(data.classId, 100);
  var days = Math.round(bwSafeNum_(data.days, 7, 365, 30));
  var tables = bwReadTables_(['Users', 'ReadingBooks', 'ReadingLogs', 'ClassMembers', 'Classes', 'Tasks', 'UserTasks']);

  var cls = classId ? tables.Classes.filter(function (c) { return String(c.ClassID) === classId; })[0] : null;
  var title = cls ? String(cls.ClassName || 'Kelas') : 'Komunitas Buku Workspace';
  var isAlumni = cls && (String(cls.ClassType||'') === 'Alumni' || String(cls.ClassID) === 'cls_alumni' || /alumni/i.test(String(cls.ClassName||'')));
  var startDate = cls ? String(cls.StartDate||'').slice(0,10) : '';
  var endDate = cls ? String(cls.EndDate||'').slice(0,10) : '';
  var cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() - days);
  var cutoffStr = Utilities.formatDate(cutoffDate, Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyy-MM-dd');

  var candidateUserIds = null;
  if (classId) {
    candidateUserIds = tables.ClassMembers
      .filter(function (m) { return String(m.ClassID) === classId; })
      .map(function (m) { return String(m.UserID); });
  }

  var board = tables.Users
    .filter(function (u) { return !candidateUserIds || candidateUserIds.indexOf(String(u.UserID)) >= 0; })
    .map(function (u) {
      var uid = String(u.UserID);
      var userJoinAlumni = String(u.AlumniJoinDate || u.JoinDate || '').slice(0,10);
      var uLogs = tables.ReadingLogs.filter(function (l) {
        if (String(l.UserID) !== uid) return false;
        var d = String(l.Date||'').slice(0,10);
        if (isAlumni) {
          if (userJoinAlumni && d < userJoinAlumni) return false;
        } else if (cls) {
          if (startDate && d < startDate) return false;
          if (endDate && d > endDate) return false;
        } else {
          if (d < cutoffStr) return false;
        }
        return true;
      });
      var pages = uLogs.reduce(function (s, l) { return s + Number(l.PagesRead || 0); }, 0);
      var effMins = uLogs.reduce(function (s, l) { return s + Number(l.EffectiveMinutes || 0); }, 0);
      var taskIds = {};
      (tables.Tasks||[]).forEach(function(t){ if(!classId || String(t.ClassID)===classId) taskIds[String(t.TaskID)]=true; });
      var tasksDone = (tables.UserTasks||[]).filter(function(ut){
        if(String(ut.UserID)!==uid) return false;
        if(classId && !taskIds[String(ut.TaskID)]) return false;
        var st = String(ut.Status||'');
        return st==='Submitted' || st==='Reviewed' || st==='Completed';
      }).length;
      return {
        userId: uid,
        name: String(u.Name || 'Pembaca'),
        username: bwUsername_(u.Username, u.Name),
        pagesRead: pages,
        effectiveMinutes: effMins,
        sessionsCount: uLogs.length,
        tasksDone: tasksDone,
        points: pages // compat, but frontend should use pagesRead
      };
    })
    .sort(function (a, b) { return b.pagesRead - a.pagesRead || b.tasksDone - a.tasksDone; });

  board.forEach(function (item, idx) { item.rank = idx + 1; });
  return { title: title, days: days, leaderboard: board, classId: classId, isAlumni: isAlumni };
}

function bwNormalizeFormBlueprint_(form) {
  var allowed = ['text', 'textarea', 'number', 'url', 'date', 'select', 'radio', 'checkbox'];
  if (!Array.isArray(form)) return [];
  var seen = {};
  return form.slice(0, 35).map(function (field, idx) {
    var id = bwClean_(field.id, 60).replace(/[^A-Za-z0-9_-]/g, '') || ('field_' + (idx + 1));
    if (seen[id]) id = id + '_' + (idx + 1);
    seen[id] = true;
    var type = allowed.indexOf(String(field.type)) >= 0 ? String(field.type) : 'text';
    var label = bwClean_(field.label, 140);
    if (!label) throw bwError_('VALIDATION', 'Setiap field pada form tugas wajib memiliki label.');
    var options = Array.isArray(field.options)
      ? field.options.slice(0, 30).map(function (o) { return bwClean_(o, 120); }).filter(Boolean)
      : [];
    if (['select', 'radio', 'checkbox'].indexOf(type) >= 0 && options.length < 2) {
      throw bwError_('VALIDATION', 'Field pilihan (' + label + ') wajib memiliki minimal 2 opsi.');
    }
    return {
      id: id,
      label: label,
      type: type,
      required: Boolean(field.required),
      options: options,
      placeholder: bwClean_(field.placeholder, 160)
    };
  });
}

function bwTaskForClient_(task, submission, cls, allSubmissions) {
  var tid = String(task.TaskID || '');
  var activeDate = String(task.ActiveDate || task.Deadline || '').slice(0, 10);
  return {
    taskId: tid,
    classId: String(task.ClassID || ''),
    className: cls ? String(cls.className || cls.ClassName || '') : 'Kelas Membaca',
    taskNumber: Number(task.TaskNumber || 0),
    title: String(task.Title || ''),
    description: String(task.Description || ''),
    activeDate: activeDate,
    deadline: activeDate,
    form: bwParseJson_(task.FormJSON, []),
    validationRule: bwParseJson_(task.ValidationRuleJSON, {}),
    status: String(task.Status || 'Published'),
    submissionCount: allSubmissions ? allSubmissions.filter(function (s) { return String(s.TaskID) === tid; }).length : 0,
    submission: submission ? {
      userTaskId: String(submission.UserTaskID || ''),
      status: String(submission.Status || ''),
      answers: bwParseJson_(submission.AnswersJSON, {}),
      feedback: String(submission.Feedback || ''),
      score: (submission.Score === '' || submission.Score === null || submission.Score === undefined) ? null : Number(submission.Score),
      submittedAt: String(submission.SubmittedAt || ''),
      reviewedAt: String(submission.ReviewedAt || '')
    } : null
  };
}

function bwListTasks_(user, data) {
  var tables = bwReadTables_(['Tasks', 'Classes', 'ClassMembers', 'UserTasks']);
  var isAdmin = String(user.Role).toLowerCase() === 'admin';
  var myClassIds = tables.ClassMembers
    .filter(function (m) { return String(m.UserID) === String(user.UserID); })
    .map(function (m) { return String(m.ClassID); });

  var tasks = tables.Tasks.filter(function (t) {
    return isAdmin || (myClassIds.indexOf(String(t.ClassID)) >= 0 && String(t.Status) !== 'Draft');
  }).map(function (t) {
    var cls = tables.Classes.filter(function (c) { return String(c.ClassID) === String(t.ClassID); })[0];
    var sub = tables.UserTasks.filter(function (ut) {
      return String(ut.TaskID) === String(t.TaskID) && String(ut.UserID) === String(user.UserID);
    })[0] || null;
    return bwTaskForClient_(t, sub, cls, tables.UserTasks);
  });

  return { tasks: tasks };
}

function bwSaveTask_(user, data) {
  bwRequireAdmin_(user);
  var taskId = bwClean_(data.taskId, 100) || bwId_('tsk');
  var classId = bwClean_(data.classId, 100);
  var title = bwClean_(data.title, 180);
  if (!classId) throw bwError_('VALIDATION', 'Pilih kelas untuk tugas ini.');
  if (title.length < 3) throw bwError_('VALIDATION', 'Judul tugas minimal 3 karakter.');

  var form = bwNormalizeFormBlueprint_(data.form || []);
  var existing = bwReadTable_('Tasks').filter(function (t) { return String(t.TaskID) === taskId; })[0];
  var now = bwNow_();
  var activeDate = data.activeDate ? bwSafeDate_(data.activeDate) : (data.deadline ? bwSafeDate_(data.deadline) : '');
  var validationRule = data.validationRule && typeof data.validationRule === 'object' ? data.validationRule : {};
  var record = {
    TaskID: taskId,
    ClassID: classId,
    TaskNumber: Math.round(bwSafeNum_(data.taskNumber, 1, 99, 1)),
    Title: title,
    Description: bwClean_(data.description, 3000),
    ActiveDate: activeDate,
    Deadline: activeDate,
    FormJSON: JSON.stringify(form),
    ValidationRuleJSON: JSON.stringify({
      type: bwClean_(validationRule.type, 60),
      minPages: Math.round(bwSafeNum_(validationRule.minPages, 0, 100000, 0)),
      category: bwClean_(validationRule.category, 60),
      bookTitle: bwClean_(validationRule.bookTitle, 200),
      author: bwClean_(validationRule.author, 120)
    }),
    Status: ['Draft', 'Published', 'Closed', 'Scheduled', 'Active', 'Expired'].indexOf(String(data.status)) >= 0 ? String(data.status) : 'Published',
    CreatedAt: existing ? String(existing.CreatedAt || now) : now,
    UpdatedAt: now
  };
  bwSaveRecord_('Tasks', 'TaskID', record);
  return { _message: 'Tugas berhasil disimpan.', task: record };
}

function bwDeleteTask_(user, data) {
  bwRequireAdmin_(user);
  var taskId = bwClean_(data.taskId, 100);
  bwDeleteWhere_('UserTasks', function (ut) { return String(ut.TaskID) === taskId; });
  bwDeleteWhere_('Tasks', function (t) { return String(t.TaskID) === taskId; });
  return { _message: 'Tugas berhasil dihapus.', deleted: true };
}

/**
 * [FIX v3.0.1] Verifikasi user terdaftar di kelas sebelum submit jawaban.
 */
function bwSubmitTask_(user, data) {
  var taskId = bwClean_(data.taskId, 100);
  var task = bwReadTable_('Tasks').filter(function (t) { return String(t.TaskID) === taskId; })[0];
  if (!task) throw bwError_('NOT_FOUND', 'Tugas tidak ditemukan.');
  var today = bwTodayStr_();
  var activeDate = String(task.ActiveDate || task.Deadline || '').slice(0,10);
  if (activeDate && today !== activeDate) {
    throw bwError_('CLOSED', 'Tugas hanya dapat dikerjakan pada tanggal aktifnya (00.00-24.00 WIB).');
  }
  var cls = bwReadTable_('Classes').filter(function(c){ return String(c.ClassID) === String(task.ClassID); })[0];
  if (cls) {
    var closeDate = String(cls.CloseDate||'').slice(0,10);
    if (String(cls.Status) === 'Closed' || (closeDate && today >= closeDate)) {
      throw bwError_('CLOSED', 'Kelas sudah ditutup. Data baru tidak dapat disimpan.');
    }
  }
  if (String(task.Status) === 'Closed') {
    throw bwError_('NOT_FOUND', 'Tugas sudah ditutup.');
  }

  // [SEC v3.0.1] Wajib terdaftar di kelas (kecuali admin)
  var isAdmin = String(user.Role).toLowerCase() === 'admin';
  if (!isAdmin) {
    var enrolled = bwReadTable_('ClassMembers').some(function (m) {
      return String(m.ClassID) === String(task.ClassID) &&
             String(m.UserID) === String(user.UserID);
    });
    if (!enrolled) {
      throw bwError_('FORBIDDEN', 'Anda belum terdaftar di kelas ini. Gabung kelas terlebih dahulu.');
    }
  }

  var form = bwParseJson_(task.FormJSON, []);
  var rawAnswers = data.answers && typeof data.answers === 'object' ? data.answers : {};
  var cleanAnswers = {};

  form.forEach(function (field) {
  var val = rawAnswers[field.id];
  if (field.type === 'checkbox') {
    val = Array.isArray(val) ? val.map(function (v) { return bwClean_(v, 140); }).filter(Boolean) : [];
    if (field.options && field.options.length) {
      val = val.filter(function (v) { return field.options.indexOf(v) >= 0; });  // ✅
    }
    if (field.required && val.length === 0) {
      throw bwError_('VALIDATION', 'Field wajib diisi: ' + field.label);
    }
  } else if (field.type === 'select' || field.type === 'radio') {
    val = bwClean_(val, 1000);
    if (field.required && !val) {
      throw bwError_('VALIDATION', 'Field wajib diisi: ' + field.label);
    }
    if (val && field.options && field.options.length && field.options.indexOf(val) < 0) {
      throw bwError_('VALIDATION', 'Nilai tidak valid untuk field: ' + field.label);  // ✅
    }
  } else {
    val = bwClean_(val, field.type === 'textarea' ? 4000 : 1000);
    if (field.required && !val) {
      throw bwError_('VALIDATION', 'Field wajib diisi: ' + field.label);
    }
  }
  cleanAnswers[field.id] = val;
});

  var existing = bwReadTable_('UserTasks').filter(function (ut) {
    return String(ut.TaskID) === taskId && String(ut.UserID) === String(user.UserID);
  })[0];

  // sebelum menyusun record
var isResubmit = existing && String(existing.Status) === 'Reviewed';

var record = {
  UserTaskID: existing ? String(existing.UserTaskID) : bwId_('ut'),
  UserID: String(user.UserID),
  TaskID: taskId,
  Status: 'Submitted',
  AnswersJSON: JSON.stringify(cleanAnswers),
  Feedback: isResubmit ? '' : (existing ? String(existing.Feedback || '') : ''),  // ✅
  Score:    isResubmit ? '' : ((existing && existing.Score !== undefined && existing.Score !== null) ? existing.Score : ''),  // ✅
  SubmittedAt: bwNow_(),
  ReviewedAt: isResubmit ? '' : (existing ? String(existing.ReviewedAt || '') : '')  // ✅
};
  bwSaveRecord_('UserTasks', 'UserTaskID', record);
  return { _message: 'Jawaban tugas berhasil dikirim!', submission: record };
}

function bwListTaskSubmissions_(user, data) {
  bwRequireAdmin_(user);
  var taskId = bwClean_(data.taskId, 100);
  var tables = bwReadTables_(['UserTasks', 'Users']);
  var usersById = {};
  tables.Users.forEach(function (u) { usersById[String(u.UserID)] = bwPublicUser_(u); });

  var list = tables.UserTasks.filter(function (ut) { return String(ut.TaskID) === taskId; }).map(function (ut) {
    var member = usersById[String(ut.UserID)] || { name: 'Anggota', email: '' };
    return {
      userTaskId: String(ut.UserTaskID),
      userId: String(ut.UserID),
      memberName: member.name,
      memberEmail: member.email,
      status: String(ut.Status || 'Submitted'),
      answers: bwParseJson_(ut.AnswersJSON, {}),
      feedback: String(ut.Feedback || ''),
      score: (ut.Score === '' || ut.Score === null || ut.Score === undefined)
  ? null
  : Number(ut.Score),
      submittedAt: String(ut.SubmittedAt || ''),
      reviewedAt: String(ut.ReviewedAt || '')
    };
  });
  return { submissions: list };
}

function bwReviewSubmission_(user, data) {
  bwRequireAdmin_(user);
  var userTaskId = bwClean_(data.userTaskId, 100);
  var sub = bwReadTable_('UserTasks').filter(function (ut) { return String(ut.UserTaskID) === userTaskId; })[0];
  if (!sub) throw bwError_('NOT_FOUND', 'Data pengumpulan tugas tidak ditemukan.');

  sub.Status = 'Reviewed';
  sub.Score = data.score === '' || data.score === null || data.score === undefined
    ? ''
    : Math.round(bwSafeNum_(data.score, 0, 100, 100));
  sub.Feedback = bwClean_(data.feedback, 2500);
  sub.ReviewedAt = bwNow_();

  bwSaveRecord_('UserTasks', 'UserTaskID', sub);
  return { _message: 'Penilaian dan feedback berhasil disimpan.', submission: sub };
}

/* ==========================================================================
 * ADMIN USER MANAGEMENT & MEMBER PROGRESS MONITOR
 * ========================================================================== */

function bwListUsers_(user, data) {
  bwRequireAdmin_(user);
  var q = bwClean_(data.query, 120).toLowerCase();
  var users = bwReadTable_('Users').map(bwPublicUser_).filter(function (u) {
    return !q || (u.name + ' ' + u.email + ' ' + u.username).toLowerCase().indexOf(q) >= 0;
  });
  return { users: users };
}

/**
 * [FIX v3.0.1] Username unik + password strength saat admin membuat/mengubah user.
 */
function bwSaveUser_(actor, data) {
  bwRequireAdmin_(actor);
  var userId = bwClean_(data.userId, 100);
  var users = bwReadTable_('Users');
  var existing = userId ? users.filter(function (u) { return String(u.UserID) === userId; })[0] : null;

  var name = bwClean_(data.name, 100);
  var email = bwEmail_(data.email);
  var username = bwUsername_(data.username, name);
  var role = String(data.role || 'Member') === 'Admin' ? 'Admin' : 'Member';
  var password = String(data.password || '');

  if (name.length < 2) throw bwError_('VALIDATION', 'Nama anggota minimal 2 karakter.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bwError_('VALIDATION', 'Format email belum valid.');
  if (users.some(function (u) { return bwEmail_(u.Email) === email && String(u.UserID) !== userId; })) {
    throw bwError_('EMAIL_TAKEN', 'Email sudah digunakan oleh akun lain.');
  }
  // [FIX v3.0.1] Username unik
  if (users.some(function (u) {
    return String(u.UserID) !== String(userId || '') &&
           bwUsername_(u.Username, u.Name) === username;
  })) {
    throw bwError_('USERNAME_TAKEN', 'Username sudah dipakai oleh akun lain.');
  }
  if (!existing && !password) {
    throw bwError_('VALIDATION', 'Kata sandi awal wajib diisi untuk akun baru.');
  }
  if (password) {
    bwValidatePasswordStrength_(password);
  }

  var salt = existing ? String(existing.PasswordSalt || bwSalt_()) : bwSalt_();
  var now = bwNow_();
  var record = {
    UserID: existing ? String(existing.UserID) : bwId_('usr'),
    Name: name,
    Username: username,
    Email: email,
    PasswordHash: password ? bwHashPassword_(password, salt) : String(existing.PasswordHash || ''),
    PasswordSalt: salt,
    Role: role,
    JoinDate: existing ? String(existing.JoinDate || now) : now,
    WaSettings: bwClean_(
  data.waSettings !== undefined
    ? data.waSettings
    : (existing ? existing.WaSettings : ''),
  60
),
    AvatarURL: existing ? String(existing.AvatarURL || '') : '',
    Bio: bwClean_(data.bio || (existing ? existing.Bio : 'Peserta Kelas Membaca'), 300),
    AuthVersion: existing ? String(Number(existing.AuthVersion || 1) + (password ? 1 : 0)) : '1',
    UpdatedAt: now
  };
  bwSaveRecord_('Users', 'UserID', record);
  return { _message: 'Data akun anggota berhasil disimpan.', user: bwPublicUser_(record) };
}

function bwDeleteUser_(actor, data) {
  bwRequireAdmin_(actor);
  var userId = bwClean_(data.userId, 100);
  if (userId === String(actor.UserID)) {
    throw bwError_('VALIDATION', 'Anda tidak dapat menghapus akun Anda sendiri.');
  }

  // 1. Identifikasi seluruh LogID milik user
  var userLogIds = bwReadTable_('ReadingLogs')
    .filter(function (r) { return String(r.UserID) === userId; })
    .map(function (r) { return String(r.LogID); });

  // 2. Hapus komentar: (a) yang ditulis oleh user, (b) yang menempel di log user
  bwDeleteWhere_('Comments', function (r) {
    return String(r.UserID) === userId || userLogIds.indexOf(String(r.LogID)) >= 0;
  });

  // 3. Hapus log & buku
  bwDeleteWhere_('ReadingLogs', function (r) { return String(r.UserID) === userId; });
  bwDeleteWhere_('ReadingBooks', function (r) { return String(r.UserID) === userId; });

  // 4. Relasi & keanggotaan
  bwDeleteWhere_('Friends', function (r) { return String(r.UserID) === userId || String(r.FriendUserID) === userId; });
  bwDeleteWhere_('ClassMembers', function (r) { return String(r.UserID) === userId; });
  bwDeleteWhere_('UserTasks', function (r) { return String(r.UserID) === userId; });
  bwDeleteWhere_('Users', function (r) { return String(r.UserID) === userId; });

  return { _message: 'Akun anggota beserta riwayatnya telah dihapus.', deleted: true };
}

function bwGetMemberProgress_(actor, data) {
  bwRequireAdmin_(actor);
  var targetId = bwClean_(data.userId, 100);
  var tables = bwReadTables_(['Users', 'ReadingBooks', 'ReadingLogs', 'ClassMembers', 'Classes']);
  var target = tables.Users.filter(function (u) { return String(u.UserID) === targetId; })[0];
  if (!target) throw bwError_('NOT_FOUND', 'Anggota tidak ditemukan.');

  var usersById = {};
  usersById[targetId] = bwPublicUser_(target);

  var logs = tables.ReadingLogs
    .filter(function (l) { return String(l.UserID) === targetId; })
    .map(function (l) { return bwNormalizeLogForClient_(l, usersById, {}); })
    .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });

  var books = tables.ReadingBooks
    .filter(function (b) { return String(b.UserID) === targetId; })
    .map(function (b) { return bwNormalizeBookForClient_(b, usersById); });

  return {
    user: bwPublicUser_(target),
    logs: logs,
    books: books
  };
}

/**
 * [NEW] Endpoint publik: siapa pun (yang login) bisa melihat rak buku pengguna lain.
 * Dipakai oleh leaderboard & tab Explore > Orang.
 */
function bwGetUserBookshelf_(actor, data) {
  var targetId = bwClean_(data.userId, 100);
  if (!targetId) throw bwError_('VALIDATION', 'Pilih anggota yang ingin dilihat rak bukunya.');

  var tables = bwReadTables_(['Users', 'ReadingBooks']);
  var target = tables.Users.filter(function (u) {
    return String(u.UserID) === targetId;
  })[0];
  if (!target) throw bwError_('NOT_FOUND', 'Anggota tidak ditemukan.');

  var usersById = {};
  usersById[targetId] = bwPublicUser_(target);

  var allBooks = tables.ReadingBooks
    .filter(function (b) { return String(b.UserID) === targetId; })
    .map(function (b) { return bwNormalizeBookForClient_(b, usersById); });

  var readingBooks = allBooks
    .filter(function (b) { return b.status !== 'Finished'; })
    .sort(function (a, b) {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });

  var finishedBooks = allBooks
    .filter(function (b) { return b.status === 'Finished'; })
    .sort(function (a, b) {
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });

  return {
    user: bwPublicUser_(target),
    readingBooks: readingBooks,
    finishedBooks: finishedBooks,
    totalBooks: allBooks.length
  };
}

/**
 * [NEW] Ekspor seluruh data server (semua tabel) ke JSON.
 * Hanya dapat dipanggil oleh Admin / Mentor.
 * Dipakai frontend untuk tombol "Ekspor Database Server".
 */
function bwExportAllData_(user) {
  bwRequireAdmin_(user);
  var tables = bwReadTables_(Object.keys(BW_CONFIG.TABLES));
  return {
    _message: 'Database server berhasil diekspor.',
    exportedAt: bwNow_(),
    version: BW_CONFIG.VERSION,
    tables: tables
  };
}

/**
 * [FIX v3.0.1] Cek username unik saat update profil.
 */
function bwUpdateProfile_(user, data) {
  var name = bwClean_(data.name, 100);
  if (name.length < 2) throw bwError_('VALIDATION', 'Nama minimal 2 karakter.');

  var newUsername = bwUsername_(data.username, name);
  if (newUsername !== bwUsername_(user.Username, user.Name)) {
    bwEnsureUniqueUsername_(newUsername, user.UserID);
  }

  user.Name = name;
  user.Username = newUsername;
  user.WaSettings = bwClean_(data.waSettings, 60);
  user.Bio = bwClean_(data.bio, 300);
  if (data.avatarURL !== undefined) user.AvatarURL = bwSafeUrl_(data.avatarURL);
  user.UpdatedAt = bwNow_();

  var saved = bwSaveRecord_('Users', 'UserID', user);
  return { _message: 'Profil berhasil diperbarui.', user: bwPublicUser_(saved) };
}

/**
 * [FIX v3.0.1] Password strength wajib untuk kata sandi baru.
 */

function bwResetPassword_(data) {
  var ident = bwClean_(data.email || data.username || data.identifier, 200).toLowerCase();
  var newPassword = String(data.newPassword || '');
  if (!ident) throw bwError_('VALIDATION', 'Email/username wajib diisi.');
  if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    throw bwError_('VALIDATION', 'Kata sandi baru minimal 8 karakter dan wajib huruf + angka.');
  }
  var users = bwReadTable_('Users');
  var row = users.filter(function(u){
    return String(u.Email||'').toLowerCase()===ident || String(u.Username||'').toLowerCase()===ident;
  })[0];
  if (!row) throw bwError_('NOT_FOUND', 'Akun tidak ditemukan.');
  var salt = bwRandomSalt_();
  var hash = bwHashPassword_(newPassword, salt);
  row.PasswordSalt = salt;
  row.PasswordHash = hash;
  row.AuthVersion = String(Number(row.AuthVersion||1)+1);
  row.UpdatedAt = bwNow_();
  bwSaveRecord_('Users', 'UserID', row);
  return { _message: 'Kata sandi berhasil direset.' };
}
function bwChangePassword_(user, data) {
  var currentPassword = String(data.currentPassword || '');
  var newPassword = String(data.newPassword || '');
  if (bwHashPassword_(currentPassword, String(user.PasswordSalt || '')) !== String(user.PasswordHash || '')) {
    throw bwError_('INVALID_CREDENTIALS', 'Kata sandi saat ini tidak cocok.');
  }
  bwValidatePasswordStrength_(newPassword);

  var salt = bwSalt_();
  user.PasswordSalt = salt;
  user.PasswordHash = bwHashPassword_(newPassword, salt);
  user.AuthVersion = String(Number(user.AuthVersion || 1) + 1);
  user.UpdatedAt = bwNow_();

  var saved = bwSaveRecord_('Users', 'UserID', user);
  var sess = bwNewSession_(saved);
  return {
    _message: 'Kata sandi berhasil diperbarui.',
    user: bwPublicUser_(saved),
    token: sess.token,
    expiresIn: sess.expiresIn
  };
}