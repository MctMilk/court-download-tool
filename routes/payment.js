const express = require('express');
const { get, run } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// 创建支付订单（预留支付接入点）
// 当前版本：记录 pending 订单，返回说明
router.post('/create-order', authenticate, (req, res) => {
  const user = req.user;
  if (user.isPaid === 1) {
    return res.status(400).json({ error: '您已是付费用户，无需重复购买' });
  }

  // TODO: 对接聚合支付平台（iPay宝 / 易支付等）
  // 1. 调用支付平台 API 创建订单
  // 2. 获取支付二维码/链接
  // 3. 写入 payment_records 表（status=pending）
  // 4. 返回 { qrCodeUrl, tradeNo, payUrl }

  res.json({
    message: '支付功能即将上线，请联系客服微信开通',
    contact: '添加客服微信并说明需要开通付费版',
    // 未来接入后返回：
    // qrCodeUrl: 'https://...',  // 支付二维码图片 URL
    // payUrl: 'https://...',      // 手机端支付跳转链接
    // tradeNo: 'ORDER_xxx',       // 本地订单号
  });
});

// 支付回调 webhook（聚合支付平台回调地址）
// 支付成功后，支付平台会 POST 到此接口
router.post('/webhook', (req, res) => {
  // TODO: 接入聚合支付后，验证回调签名
  // const { trade_no, status, amount } = req.body;
  // 1. 验证签名（防止伪造回调）
  // 2. 查询 payment_records，找到对应订单
  // 3. 验证金额和状态
  // 4. 更新 users.is_paid = 1

  // 当前返回 200，避免支付平台重试
  res.json({ received: true });
});

// 查询支付订单状态
router.get('/order/:tradeNo', authenticate, (req, res) => {
  const { tradeNo } = req.params;
  try {
    const record = await getAsync('SELECT * FROM payment_records WHERE trade_no = ? AND user_id = ?', [tradeNo, req.user.userId]);

    if (!record) {
      return res.status(404).json({ error: '订单不存在' });
    }
    res.json({ status: record.status, amount: record.amount, createdAt: record.created_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
