const crypto = require('crypto');

// 预置题库：{ question: 显示文本, answer: 正确答案 }
const PROBLEMS = [
  { q: '3 + 5 = ?',         a: '8'   },
  { q: '7 + 2 = ?',         a: '9'   },
  { q: '9 - 4 = ?',         a: '5'   },
  { q: '6 - 3 = ?',         a: '3'   },
  { q: '2 × 4 = ?',         a: '8'   },
  { q: '3 × 3 = ?',         a: '9'   },
  { q: '8 ÷ 2 = ?',         a: '4'   },
  { q: '6 ÷ 3 = ?',         a: '2'   },
  { q: '11 - 5 = ?',        a: '6'   },
  { q: '4 + 7 = ?',         a: '11'  },
  { q: '15 - 8 = ?',        a: '7'   },
  { q: '5 × 2 = ?',         a: '10'  },
  { q: '9 ÷ 3 = ?',         a: '3'   },
  { q: '12 - 6 = ?',        a: '6'   },
  { q: '2 + 9 = ?',         a: '11'  },
  { q: '18 ÷ 3 = ?',        a: '6'   },
  { q: '4 × 3 = ?',         a: '12'  },
  { q: '20 - 9 = ?',        a: '11'  },
  { q: '7 + 6 = ?',         a: '13'  },
  { q: '25 - 8 = ?',        a: '17'  },
];

const captchaStore = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, v] of captchaStore) {
    if (now - v.created > 180000) captchaStore.delete(id);
  }
}, 30000);

// 生成 SVG 扭曲图片
function genSvgImage(text) {
  // 随机参数
  const bgColors = ['#f0f4f8', '#fafafa', '#f5f0ff', '#fff5f5'];
  const bg = bgColors[Math.floor(Math.random() * bgColors.length)];

  // 扭曲：给每个字符随机偏移 + 旋转 + 颜色变化
  const chars = text.split('');
  const charEls = chars.map(ch => {
    const dx = (Math.random() - 0.5) * 12;
    const dy = (Math.random() - 0.5) * 8;
    const rot = (Math.random() - 0.5) * 30;
    const colors = ['#2563eb', '#1e40af', '#4f46e5', '#7c3aed', '#dc2626'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const fontSize = 26 + Math.floor(Math.random() * 8);
    return `<text x="${dx}" y="42" font-family="Arial,Helvetica,sans-serif" font-size="${fontSize}" font-weight="bold" fill="${color}" transform="rotate(${rot} ${dx} 40)" text-anchor="middle">${escapeXml(ch)}</text>`;
  }).join('');

  // 添加干扰线
  const lines = Array.from({ length: 3 }, () => {
    const x1 = Math.random() * 200;
    const y1 = Math.random() * 70;
    const x2 = Math.random() * 200;
    const y2 = Math.random() * 70;
    const colors = ['#cbd5e1', '#94a3b8', '#e2e8f0'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${1 + Math.random() * 1.5}" opacity="0.5"/>`;
  }).join('');

  // 添加噪点
  const dots = Array.from({ length: 20 }, () => {
    const x = Math.random() * 220;
    const y = Math.random() * 80;
    const r = 0.5 + Math.random() * 1.5;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="#94a3b8" opacity="${0.2 + Math.random() * 0.3}"/>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="80" style="background:${bg}">
  <filter id="n">
    <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="3" result="noise"/>
    <feDisplacementMap in="SourceGraphic" in2="noise" scale="4" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <g filter="url(#n)" opacity="0.25">${chars.map((_, i) => {
    const dx = 30 + i * 22 + (Math.random() - 0.5) * 6;
    const dy = 40 + (Math.random() - 0.5) * 10;
    const rot = (Math.random() - 0.5) * 20;
    const colors = ['#1d4ed8', '#4338ca', '#6d28d9', '#be123c'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const fs = 28 + Math.floor(Math.random() * 10);
    return `<text x="${dx}" y="${dy}" font-family="Arial Black,Arial,sans-serif" font-size="${fs}" font-weight="900" fill="${color}" transform="rotate(${rot} ${dx} ${dy})" text-anchor="middle">${escapeXml(chars[i])}</text>`;
  }).join('')}</g>
  ${lines}
  ${dots}
  </svg>`;

  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function newCaptcha() {
  const problem = PROBLEMS[Math.floor(Math.random() * PROBLEMS.length)];
  const id = crypto.randomBytes(16).toString('hex');
  const image = genSvgImage(problem.q);
  captchaStore.set(id, {
    answer: problem.a,
    created: Date.now(),
    used: false,
  });
  return { id, image };
}

function verifyCaptcha(id, answer) {
  const entry = captchaStore.get(id);
  if (!entry) return { valid: false, reason: '验证码已过期，请重新获取' };
  if (entry.used) return { valid: false, reason: '验证码已使用，请重新获取' };
  const correct = String(entry.answer).trim();
  const input = String(answer).trim();
  if (correct !== input) return { valid: false, reason: '答案错误，请重新计算' };
  entry.used = true;
  return { valid: true };
}

module.exports = { newCaptcha, verifyCaptcha };
