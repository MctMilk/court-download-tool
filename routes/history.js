const express = require('express');
const { get, run } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// 提取案号（格式如 (2026)苏01民初123号）
function extractCaseNumber(content) {
  if (!content) return '';
  const m = content.match(/\([0-9]+\)[^\s(]{2,10}[\u4e00-\u9fa5]{1,10}[\u4e00-\u9fa5民初民终号\d]+/);
  return m ? m[0] : '';
}

// ─── 获取历史记录列表 ──────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const rows = get.all('SELECT * FROM sms_history WHERE user_id=? ORDER BY created_at DESC LIMIT 50', req.user.userId);
  res.json({
    history: rows.map(r => ({
      id: r.id,
      content: r.content,
      court: r.court || '',
      caseNumber: r.case_number || '',
      docCount: r.doc_count || 0,
      createdAt: r.created_at,
    })),
  });
});

// ─── 保存解析记录 ──────────────────────────────────────────────────
router.post('/', authenticate, (req, res) => {
  const { content, params, court, doc_count } = req.body;
  if (!content) return res.status(400).json({ error: '内容不能为空' });

  const case_number = extractCaseNumber(content);
  run('INSERT INTO sms_history (user_id, content, params, court, case_number, doc_count) VALUES (?,?,?,?,?,?)', [req.user.userId,
    content,
    JSON.stringify(params || {}),
    court || '',
    case_number,
    doc_count || 0,
  ]);
  res.json({ success: true });
});

// ─── 删除历史记录 ────────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  const row = get('SELECT id FROM sms_history WHERE id=? AND user_id=?', [req.params.id, req.user.userId]);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  run('DELETE FROM sms_history WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
