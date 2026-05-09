const express = require('express');
const { getAsync, runAsync, allAsync } = require('../db');
const { authenticate } = require('../middleware/auth');
const wxpay = require('../utils/wxpay');

const router = express.Router();

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
    const wxResult = await wxpay.unifiedOrder({
      outTradeNo,
      totalFee: Math.round(price * 100), // 元转分，整数
      body,
    });

    if (wxResult.return_code !== 'SUCCESS') {
      console.error('微信统一下单失败:', wxResult.return_msg);
      return res.status(500).json({ error: '支付通道异常，请稍后重试' });
    }

    if (wxResult.result_code !== 'SUCCESS') {
      console.error('微信业务失败:', wxResult.err_code, wxResult.err_code_des);
      return res.status(500).json({ error: wxResult.err_code_des || '支付通道异常' });
    }

    // 写入订单记录
    await runAsync(
      `INSERT INTO payment_records (user_id, amount, trade_no, status, recharge_type, recharge_months, wx_code_url, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, datetime('now', '+8 hours'))`,
      [userId, price, outTradeNo, type, addMonths, wxResult.code_url]
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

module.exports = router;
