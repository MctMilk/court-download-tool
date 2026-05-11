const express = require('express');
const { getAsync, runAsync, allAsync } = require('../db');
const { authenticate } = require('../middleware/auth');
const wxpay = require('../utils/wxpay');

const router = express.Router();

// ─── 新退费公式核心计算 ──────────────────────────────────────
const MONTHLY_RATE = 1.0;  // 元/天
const YEARLY_RATE  = 0.5;  // 元/天
const MONTHLY_CAP  = 5.0;  // 每完整月封顶

function computeRefund(paymentRecords, subscriptionStartedAt, refundTime) {
  const totalPaid = paymentRecords
    .filter(r => r.status === 'paid')
    .reduce((s, r) => s + (r.amount || 0), 0);
  if (totalPaid <= 0 || !subscriptionStartedAt) return { refund: 0, totalPaid, consumed: 0 };

  const latest = paymentRecords
    .filter(r => r.status === 'paid')
    .sort((a, b) => new Date(b.paid_at || 0) - new Date(a.paid_at || 0))[0];
  const isYearly = latest?.recharge_type === 'yearly' ||
    (latest?.recharge_type === 'monthly' && (latest?.recharge_months || 0) >= 10);
  const dailyRate = isYearly ? YEARLY_RATE : MONTHLY_RATE;

  let consumed = 0;
  const start = new Date(subscriptionStartedAt.replace(' ', 'T') + 'Z');
  const end   = refundTime ? new Date(refundTime.replace(' ', 'T') + 'Z') : new Date();
  let cursor  = new Date(start);

  while (cursor < end) {
    if (cursor.getUTCDate() === 1) {
      const year  = cursor.getUTCFullYear();
      const month = cursor.getUTCMonth();
      const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      consumed += Math.min(daysInMonth * dailyRate, MONTHLY_CAP);
      cursor = new Date(Date.UTC(year, month + 1, 1));
    } else {
      consumed += dailyRate;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  const refund = Math.max(0, Math.round((totalPaid - consumed) * 100) / 100);
  return { refund, totalPaid, consumed: Math.round(consumed * 100) / 100 };
}

// async 版邀请奖励发放（用于 payment.js 的 async 上下文）
async function _applyInviteRewardAsync(inviter, type, months, desc) {
  const now = new Date();
  let expires = inviter.paid_expires_at ? new Date(inviter.paid_expires_at) : now;
  if (expires <= now) expires = now;
  expires.setMonth(expires.getMonth() + months);
  const newExpires = expires.toISOString().replace('T', ' ').slice(0, 19);
  const levelMap = { monthly: 1, monthly2: 2, yearly: 3 };
  await runAsync("UPDATE users SET lifetime=0, is_paid=1, paid_expires_at=? WHERE id=?", [newExpires, inviter.id]);
  await runAsync("INSERT INTO invite_rewards (user_id, reward_type, reward_desc, level, granted_at) VALUES (?,?,?,?,datetime('now','+8 hours'))",
    [inviter.id, type, desc, levelMap[type] || 1]);
  console.log(`邀请奖励发放: 邀请人${inviter.id}获得${desc}`);
}

// 套餐价格计算（从 user.js 复用）
function calcRecharge(type, months) {
  if (type === 'monthly') return { price: 5 * months, months };
  const prices = { 1: 50, 2: 80, 3: 105 };
  return { price: prices[months] || 50, months: months * 12 };
}

// 到期时间计算（自然月顺延）
function calcExpiresAt(currentExpires, addMonths) {
  if (currentExpires && String(currentExpires).includes('9999')) return currentExpires;
  const base = currentExpires ? new Date(currentExpires) : new Date();
  base.setMonth(base.getMonth() + addMonths);
  return base.toISOString().replace('T', ' ').slice(0, 19);
}

// 生成订单号
function genTradeNo() {
  return 'CS_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// -------------------------------------------------------
// POST /create — 创建微信支付订单
// -------------------------------------------------------
router.post('/create', authenticate, async (req, res) => {
  const userId = req.user.userId;
  const { type, months } = req.body;

  // 验证套餐参数
  if (!['monthly', 'yearly'].includes(type)) return res.status(400).json({ error: '无效的充值类型' });
  if (type === 'monthly' && (!months || months < 1 || months > 12)) return res.status(400).json({ error: '按月充值请选择1~12个月' });
  if (type === 'yearly' && (!months || months < 1 || months > 3)) return res.status(400).json({ error: '按年充值请选择1~3年' });

  try {
    // 查用户信息
    const user = await getAsync('SELECT id, lifetime, paid_expires_at FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    // 终身用户拒绝
    if (user.lifetime === 1) {
      return res.status(400).json({ error: '您已是终身会员，无需续费' });
    }

    const { price, months: addMonths } = calcRecharge(type, months);
    const outTradeNo = genTradeNo();

    // body: 微信支付订单显示的商品描述
    const body = type === 'monthly'
      ? `法院文书-月付套餐(${months}个月)`
      : `法院文书-年付套餐(${months === 1 ? '1年' : months === 2 ? '2年' : '3年'})`;

    // 调用微信统一下单
    let wxResult;
    try {
      wxResult = await wxpay.unifiedOrder({
        outTradeNo,
        totalFee: Math.round(price * 100), // 元转分，整数
        body,
      });
    } catch (err) {
      console.error('微信API调用异常:', err);
      return res.status(500).json({
        error: '支付通道异常，请稍后重试',
        _debug: { type: 'network_error', message: String(err.message || err) }
      });
    }

    if (!wxResult) {
      console.error('微信API返回undefined');
      return res.status(500).json({ error: '支付通道异常，请稍后重试' });
    }

    if (wxResult.return_code !== 'SUCCESS') {
      console.error('微信统一下单失败:', wxResult.return_msg, wxResult);
      return res.status(500).json({
        error: wxResult.return_msg || '支付通道异常',
        _debug: { wxReturn: wxResult }
      });
    }

    if (wxResult.result_code !== 'SUCCESS') {
      console.error('微信业务失败:', wxResult.err_code, wxResult.err_code_des, wxResult);
      return res.status(500).json({
        error: wxResult.err_code_des || '支付通道异常',
        _debug: { wxReturn: wxResult }
      });
    }

    // 写入订单记录
    await runAsync(
      `INSERT INTO payment_records (user_id, amount, trade_no, status, recharge_type, recharge_months, wx_code_url, wx_prepay_id, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, datetime('now', '+8 hours'))`,
      [userId, price, outTradeNo, type, addMonths, wxResult.code_url, wxResult.prepay_id || null]
    );

    res.json({
      tradeNo: outTradeNo,
      amount: price,
      type,
      months: addMonths,
      codeUrl: wxResult.code_url,
    });
  } catch (err) {
    console.error('创建支付订单失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------
// GET /order/:tradeNo — 轮询订单状态
// -------------------------------------------------------
router.get('/order/:tradeNo', authenticate, async (req, res) => {
  const { tradeNo } = req.params;
  try {
    const record = await getAsync(
      'SELECT * FROM payment_records WHERE trade_no = ? AND user_id = ?',
      [tradeNo, req.user.userId]
    );
    if (!record) return res.status(404).json({ error: '订单不存在' });
    res.json({
      tradeNo: record.trade_no,
      status: record.status,
      amount: record.amount,
      type: record.recharge_type,
      months: record.recharge_months,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------
// POST /notify — 微信支付回调（最关键，无认证，验签为主）
// -------------------------------------------------------
// 微信回调是 XML 格式，需要 express.text() 中间件
router.post('/notify', express.text({ type: '*/*' }), async (req, res) => {
  let xmlData;
  try {
    xmlData = wxpay.parseXML(req.body.toString());
  } catch (err) {
    console.error('解析微信回调XML失败:', err);
    return res.status(400).send('<xml><return_code>FAIL</return_code><return_msg>parse error</return_msg></xml>');
  }

  // 构造待验签的字符串（不含sign字段，字典序）
  const { return_code, result_code, transaction_id, out_trade_no, total_fee, mch_id, sign } = xmlData;

  if (return_code !== 'SUCCESS') {
    console.error('微信回调return_code非SUCCESS:', xmlData);
    return res.status(200).send('<xml><return_code>FAIL</return_code></xml>');
  }

  // 验证商户号
  if (mch_id !== process.env.WX_MCH_ID) {
    console.error('商户号不匹配:', mch_id);
    return res.status(200).send('<xml><return_code>FAIL</return_code><return_msg>mch_id mismatch</return_msg></xml>');
  }

  // 验签
  const computedSign = wxpay.buildSignature(xmlData);
  if (computedSign !== sign) {
    console.error('微信回调验签失败:', { computed: computedSign, received: sign });
    return res.status(200).send('<xml><return_code>FAIL</return_code><return_msg>sign error</return_msg></xml>');
  }

  if (result_code !== 'SUCCESS') {
    console.error('微信回调result_code非SUCCESS:', xmlData);
    return res.status(200).send('<xml><return_code>FAIL</return_code><return_msg>result_code error</return_msg></xml>');
  }

  // 查询本地订单
  const record = await getAsync('SELECT * FROM payment_records WHERE trade_no = ?', [out_trade_no]);
  if (!record) {
    console.error('订单不存在:', out_trade_no);
    return res.status(200).send('<xml><return_code>FAIL</return_code><return_msg>order not found</return_msg></xml>');
  }

  // 幂等：已支付直接返回成功
  if (record.status === 'paid') {
    return res.status(200).send('<xml><return_code>SUCCESS</return_code><return_msg>OK</return_msg></xml>');
  }

  // 金额校验：微信传分，本地存元
  const localFeeYuan = Math.round(record.amount * 100);
  if (Number(total_fee) !== localFeeYuan) {
    console.error('金额不匹配: wx=', total_fee, 'local=', localFeeYuan);
    // 金额不符也要返回SUCCESS，避免微信重试；但记录告警，不激活订阅
    return res.status(200).send('<xml><return_code>SUCCESS</return_code><return_msg>amount mismatch</return_msg></xml>');
  }

  // 获取用户信息
  const user = await getAsync('SELECT * FROM users WHERE id = ?', [record.user_id]);
  if (!user) {
    console.error('用户不存在, id:', record.user_id);
    return res.status(200).send('<xml><return_code>FAIL</return_code><return_msg>user not found</return_msg></xml>');
  }

  const addMonths = record.recharge_months;
  const newExpiresAt = calcExpiresAt(user.paid_expires_at, addMonths);

  // 更新订单状态
  await runAsync(
    `UPDATE payment_records SET status = 'paid', wx_transaction_id = ?, paid_at = datetime('now', '+8 hours'), notify_ip = ? WHERE trade_no = ?`,
    [transaction_id, req.ip, out_trade_no]
  );

  // 激活用户订阅（终身用户跳过）
  if (user.lifetime !== 1) {
    await runAsync(
      `UPDATE users SET is_paid = 1, paid_expires_at = ? WHERE id = ?`,
      [newExpiresAt, user.id]
    );
  }

  // 记录余额流水
  await runAsync(
    `INSERT INTO balance_log (user_id, amount, type, description, created_at) VALUES (?, ?, '充值', ?, datetime('now', '+8 hours'))`,
    [user.id, record.amount, `微信支付-${record.recharge_type === 'monthly' ? '月付' : '年付'}套餐(${addMonths}个月)`]
  );

  // ── 记录首次订阅时间（仅首次付费时写入）─────────────────────
  const periodType = (record.recharge_type === 'monthly' && addMonths >= 10) ? 'yearly' : record.recharge_type;
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const existingStart = await getAsync('SELECT id FROM subscription_starts WHERE user_id = ?', [user.id]);
  if (!existingStart) {
    await runAsync(
      `INSERT INTO subscription_starts (user_id, started_at, original_plan_type, original_amount) VALUES (?, ?, ?, ?)`,
      [user.id, nowStr, periodType, record.amount]
    );
    await runAsync(
      `UPDATE users SET subscription_started_at = ? WHERE id = ?`,
      [nowStr, user.id]
    );
    console.log(`订阅开通: 用户${user.id} 首次订阅，类型${periodType}，金额${record.amount}元`);
  } else {
    console.log(`订阅续费: 用户${user.id} 充值${record.amount}元`);
  }

  // 邀请人奖励检查（被邀请人付费时，邀人可能达到新阈值）
  const inviterRel = await getAsync(
    'SELECT inviter_id FROM invite_relations WHERE invitee_id = ?', [user.id]
  );
  if (inviterRel) {
    const inviter = await getAsync('SELECT * FROM users WHERE id = ?', [inviterRel.inviter_id]);
    if (inviter && inviter.lifetime !== 1) {
      const totalReg = (await getAsync('SELECT COUNT(*) as c FROM invite_relations WHERE inviter_id=?', [inviterRel.inviter_id]))?.c || 0;
      const totalPaid = (await getAsync(`
        SELECT COUNT(*) as c FROM invite_relations ir
        JOIN users u ON ir.invitee_id = u.id
        WHERE ir.inviter_id=? AND (u.lifetime=1 OR (u.is_paid=1 AND u.paid_expires_at>datetime('now')))
      `, [inviterRel.inviter_id]))?.c || 0;
      const hasMonthly  = !!(await getAsync('SELECT id FROM invite_rewards WHERE user_id=? AND reward_type=?', [inviterRel.inviter_id, 'monthly']));
      const hasMonthly2 = !!(await getAsync('SELECT id FROM invite_rewards WHERE user_id=? AND reward_type=?', [inviterRel.inviter_id, 'monthly2']));
      const hasYearly   = !!(await getAsync('SELECT id FROM invite_rewards WHERE user_id=? AND reward_type=?', [inviterRel.inviter_id, 'yearly']));

      if (!hasMonthly && (totalReg >= 10 || totalPaid >= 5)) {
        await _applyInviteRewardAsync(inviter, 'monthly', 1, '月度邀请奖励（+1个月）');
        return;
      }
      if (!hasMonthly2 && (totalReg >= 20 || totalPaid >= 10)) {
        await _applyInviteRewardAsync(inviter, 'monthly2', 1, '第2个月度邀请奖励（+1个月）');
        return;
      }
      if (!hasYearly && totalPaid >= 30) {
        await _applyInviteRewardAsync(inviter, 'yearly', 10, '年度邀请奖励（+10个月）');
        return;
      }
      const hasLifetime = !!(await getAsync('SELECT id FROM invite_rewards WHERE user_id=? AND reward_type=?', [inviterRel.inviter_id, 'lifetime']));
      if (!hasLifetime && totalPaid >= 100) {
        await runAsync("UPDATE users SET lifetime=1, is_paid=1, paid_expires_at='9999-12-31 23:59:59' WHERE id=?", [inviter.id]);
        await runAsync("INSERT INTO invite_rewards (user_id, reward_type, reward_desc, level, granted_at) VALUES (?,?,?,?,datetime('now','+8 hours'))",
          [inviter.id, 'lifetime', '终身会员（累计100名付费用户）', 4]);
        console.log(`邀请奖励发放: 邀请人${inviter.id}获得终身会员`);
      }
    }
  }

  console.log(`支付成功: 用户${user.id} 充值${record.amount}元 套餐${addMonths}个月 到期时间${newExpiresAt}`);
  return res.status(200).send('<xml><return_code>SUCCESS</return_code><return_msg>OK</return_msg></xml>');
});

// -------------------------------------------------------
// POST /close/:tradeNo — 关闭超时订单
// -------------------------------------------------------
router.post('/close/:tradeNo', authenticate, async (req, res) => {
  const { tradeNo } = req.params;
  try {
    const record = await getAsync(
      'SELECT * FROM payment_records WHERE trade_no = ? AND user_id = ?',
      [tradeNo, req.user.userId]
    );
    if (!record) return res.status(404).json({ error: '订单不存在' });
    if (record.status !== 'pending') return res.status(400).json({ error: '订单状态不允许关闭' });

    // 调用微信关单
    await wxpay.closeOrder(tradeNo);
    await runAsync("UPDATE payment_records SET status = 'closed' WHERE trade_no = ?", [tradeNo]);
    res.json({ message: '订单已关闭' });
  } catch (err) {
    console.error('关闭订单失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 余额流水（用户自查看） ─────────────────────────────────────
router.get('/balance-log', authenticate, async (req, res) => {
  const userId = req.user.userId;

  // 防御：若 subscription_started_at 列不存在，降级查询
  let user = null;
  let subscriptionStartedAt = null;
  try {
    user = await getAsync('SELECT id, lifetime, subscription_started_at FROM users WHERE id = ?', [userId]);
    if (user) subscriptionStartedAt = user.subscription_started_at;
  } catch (e) {
    try {
      user = await getAsync('SELECT id, lifetime FROM users WHERE id = ?', [userId]);
    } catch (e2) {
      console.error('[balance-log] user query failed:', e2.message);
      return res.status(500).json({ error: '用户查询失败' });
    }
  }

  if (user?.lifetime === 1) {
    return res.json({ lifetime: true, message: '尊贵的终身会员，感谢您的大力支持！' });
  }

  let logs = [];
  let records = [];
  let refundable = 0;
  let pendingReq = null;

  try {
    logs = await allAsync('SELECT * FROM balance_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [userId]);
  } catch (e) {
    console.error('[balance-log] logs query failed:', e.message);
    return res.status(500).json({ error: '流水查询失败' });
  }

  try {
    records = await allAsync("SELECT * FROM payment_records WHERE user_id = ? AND status = 'paid'", [userId]);
    const r = computeRefund(records, subscriptionStartedAt);
    refundable = r.refund;
  } catch (e) {
    console.error('[balance-log] payment records/refund compute failed:', e.message);
    return res.status(500).json({ error: '支付记录查询失败' });
  }

  try {
    pendingReq = await getAsync("SELECT id FROM refund_requests WHERE user_id = ? AND status = 'pending'", [userId]);
  } catch (e) {
    // 表不存在时忽略
  }

  res.json({
    lifetime: false,
    refundable,
    hasPendingRequest: !!pendingReq,
    logs: logs.map(l => ({ id: l.id, type: l.type, amount: l.amount, description: l.description, createdAt: l.created_at })),
  });
});

// ─── 退款申请（用户发起申请，管理员审核后执行） ──────────────────
router.post('/refund-request', authenticate, async (req, res) => {
  try {
    const userId = req.user.userId;

    // 防御：若 subscription_started_at 列不存在，降级查询
    let user = null;
    let subscriptionStartedAt = null;
    try {
      user = await getAsync('SELECT id, phone, lifetime, subscription_started_at FROM users WHERE id = ?', [userId]);
      if (user) subscriptionStartedAt = user.subscription_started_at;
    } catch (e) {
      user = await getAsync('SELECT id, phone, lifetime FROM users WHERE id = ?', [userId]);
    }

    // 终身用户不能申请
    if (user?.lifetime === 1) {
      return res.status(400).json({ error: '终身会员不支持在线退款，如有余额请联系管理员' });
    }

    // 已有 pending 申请
    let existing = null;
    try {
      existing = await getAsync(
        "SELECT id FROM refund_requests WHERE user_id = ? AND status = 'pending'",
        [userId]
      );
    } catch {}
    if (existing) {
      return res.status(400).json({ error: '已有退款申请正在处理中，请等待管理员审核' });
    }

    // 新公式计算可退金额
    const records = await allAsync(
      "SELECT * FROM payment_records WHERE user_id = ? AND status = 'paid'",
      [userId]
    );
    const result = computeRefund(records, subscriptionStartedAt);

    if (result.refund <= 0) {
      return res.status(400).json({ error: '当前无可退款金额' });
    }

    await runAsync(
      `INSERT INTO refund_requests (user_id, user_phone, amount, computed_amount, formula_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', datetime('now', '+8 hours'))`,
      [userId, user?.phone || '', result.refund, result.refund, JSON.stringify(result)]
    );

    res.json({ message: '退款申请已提交，等待管理员审核', refundAmount: result.refund });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
