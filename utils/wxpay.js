/**
 * 微信支付 V2 Native — 工具模块
 * 签名算法：MD5，XML 通信格式
 */
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

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
 * 微信返回的 XML 是同级多标签，贪婪/非贪婪回溯均会误匹配，
 * 故用状态机从左到右解析：遇到 <tag> 则记录起点，遇到 </tag> 则提取内容
 */
function parseXML(xml) {
  const plain = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  // 跳过根 <xml> 标签，改为直接解析其内部内容
  let content = plain;
  const rootMatch = /^<xml>([\s\S]*)<\/xml>$/.exec(plain);
  if (rootMatch) content = rootMatch[1];

  const obj = {};
  // 用 search 而非 match+pos（^ 在 pos>0 时不生效）
  let i = 0;
  while (i < content.length) {
    // 跳过空白
    while (i < content.length && content.charCodeAt(i) <= 32) i++;
    if (i >= content.length || content[i] !== '<') break;
    // 找到 <tagName>
    const tagMatch = content.substring(i).match(/^<(\w+)>/);
    if (!tagMatch) break;
    const tagName = tagMatch[1];
    const contentStart = i + tagMatch[0].length;
    // 找 </tagName>
    const closeTag = '</' + tagName + '>';
    const contentEnd = content.indexOf(closeTag, contentStart);
    if (contentEnd === -1) break;
    obj[tagName] = content.substring(contentStart, contentEnd).trim();
    i = contentEnd + closeTag.length;
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
      res.on('end', () => {
        console.log('[wxpay] 微信API响应, path=', path, 'raw=', raw.slice(0, 500));
        if (!raw) return reject(new Error('微信API返回空'));
        resolve(parseXML(raw));
      });
      res.on('error', e => {
        console.error('[wxpay] 响应流错误:', e.message);
        reject(new Error('响应流错误: ' + e.message));
      });
    });
    req.on('error', e => {
      console.error('[wxpay] 请求错误:', e.message);
      reject(new Error('微信API请求失败: ' + e.message));
    });
    // 10秒超时
    req.setTimeout(10000, () => {
      console.error('[wxpay] 请求超时:', path);
      req.destroy();
      reject(new Error('微信API请求超时（10秒）'));
    });
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
  const { transactionId, outTradeNo, totalFee, refundFee, outRefundNo, description } = opts;
  const params = {
    appid: APPID,
    mch_id: MCH_ID,
    nonce_str: nonceStr(),
    total_fee: totalFee,
    refund_fee: refundFee,
    out_refund_no: outRefundNo,
    refund_desc: description || '用户退款',
  };
  // 优先用 transaction_id，退款接口支持两种
  if (transactionId) params.transaction_id = transactionId;
  else if (outTradeNo) params.out_trade_no = outTradeNo;
  params.sign = buildSignature(params);

  // 退款需要双向证书
  const CERT_DIR = path.join(__dirname, '..', 'certs');
  const certPem = path.join(CERT_DIR, 'apiclient_cert.pem');
  const keyPem = path.join(CERT_DIR, 'apiclient_key.pem');
  return wxRequestWithCert('/secapi/pay/refund', params, certPem, keyPem);
}

/**
 * 发送带客户端证书的 HTTPS POST 请求（用于退款等需要证书的接口）
 */
function wxRequestWithCert(path, data, certPath, keyPath) {
  return new Promise((resolve, reject) => {
    const body = toXML(data);
    const options = {
      hostname: API_BASE,
      path,
      method: 'POST',
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        console.log('[wxpay] 退款API响应, path=', path, 'raw=', raw.slice(0, 500));
        if (!raw) return reject(new Error('微信退款API返回空'));
        resolve(parseXML(raw));
      });
      res.on('error', e => reject(new Error('退款响应流错误: ' + e.message)));
    });
    req.on('error', e => reject(new Error('退款请求失败: ' + e.message)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('退款请求超时（15秒）')); });
    req.write(body);
    req.end();
  });
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
