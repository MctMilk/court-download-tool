/**
 * 微信支付 V2 Native — 工具模块
 * 签名算法：MD5，XML 通信格式
 */
const crypto = require('crypto');
const https = require('https');

const APPID = process.env.WX_APPID;
const MCH_ID = process.env.WX_MCH_ID;
const API_KEY = process.env.WX_API_KEY;
const NOTIFY_URL = process.env.WX_NOTIFY_URL || 'https://pozhida.com/wenshu/api/payment/notify';
const API_BASE = 'api.mch.weixin.qq.com';

/**
 * 生成随机字符串（nonce_str）
 */
function nonceStr(len = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * V2 MD5 签名
 * 将 params 按 key 字典序排列，拼接 k=v&k=v...，末尾拼接 &key=API密钥
 * 然后 MD5 并转大写
 */
function buildSignature(params) {
  const sorted = Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '' && k !== 'sign')
    .sort();
  const stringA = sorted.map(k => `${k}=${params[k]}`).join('&');
  const stringSignTemp = stringA + '&key=' + API_KEY;
  return crypto.createHash('md5').update(stringSignTemp, 'utf8').digest('hex').toUpperCase();
}

/**
 * 解析 XML 为 JS 对象
 */
function parseXML(xml) {
  const obj = {};
  const pattern = /<(\w+)>(<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<=\1>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    obj[match[1]] = match[3] !== undefined ? match[3] : (match[4] || '');
  }
  // Fallback: simple tag extraction for simple XML
  if (Object.keys(obj).length === 0) {
    const tagP = /<(\w+)>([\s\S]*?)<\/\1>/g;
    while ((match = tagP.exec(xml)) !== null) {
      obj[match[1]] = match[2].trim();
    }
  }
  return obj;
}

/**
 * JS 对象序列化为 XML
 */
function toXML(obj) {
  const entries = Object.entries(obj).map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`).join('');
  return `<xml>${entries}</xml>`;
}

/**
 * 发送 HTTPS POST 请求到微信支付 API
 */
function wxRequest(path, data) {
  return new Promise((resolve, reject) => {
    const body = toXML(data);
    const options = {
      hostname: API_BASE,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'court-tool/1.0',
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve(parseXML(raw)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 统一下单（Native 扫码支付）
 * @param {object} params - { outTradeNo, totalFee(分), body, notifyUrl }
 */
async function unifiedOrder({ outTradeNo, totalFee, body, notifyUrl = NOTIFY_URL }) {
  const params = {
    appid: APPID,
    mch_id: MCH_ID,
    nonce_str: nonceStr(),
    body,
    out_trade_no: outTradeNo,
    total_fee: totalFee,
    spbill_create_ip: '8.8.8.8', // 统一下单不需要真实IP，可填任意
    notify_url: notifyUrl,
    trade_type: 'NATIVE',
  };
  params.sign = buildSignature(params);
  return wxRequest('/pay/unifiedorder', params);
}

/**
 * 查询订单
 */
async function orderQuery(outTradeNo) {
  const params = {
    appid: APPID,
    mch_id: MCH_ID,
    nonce_str: nonceStr(),
    out_trade_no: outTradeNo,
  };
  params.sign = buildSignature(params);
  return wxRequest('/pay/orderquery', params);
}

/**
 * 关闭订单
 */
async function closeOrder(outTradeNo) {
  const params = {
    appid: APPID,
    mch_id: MCH_ID,
    nonce_str: nonceStr(),
    out_trade_no: outTradeNo,
  };
  params.sign = buildSignature(params);
  return wxRequest('/pay/closeorder', params);
}

/**
 * 退款（需要证书）
 * @param {object} opts - { transactionId, totalFee, refundFee, outRefundNo, description }
 */
async function refund(opts) {
  const { transactionId, totalFee, refundFee, outRefundNo, description } = opts;
  const params = {
    appid: APPID,
    mch_id: MCH_ID,
    nonce_str: nonceStr(),
    transaction_id: transactionId,
    total_fee: totalFee,
    refund_fee: refundFee,
    out_refund_no: outRefundNo,
    refund_desc: description || '用户退款',
  };
  params.sign = buildSignature(params);
  // 退款需要证书，这里仅返回构造的参数，实际退款在 payment.js 中用 https.request + 证书实现
  return params;
}

module.exports = {
  nonceStr,
  buildSignature,
  parseXML,
  toXML,
  unifiedOrder,
  orderQuery,
  closeOrder,
  refund,
};
