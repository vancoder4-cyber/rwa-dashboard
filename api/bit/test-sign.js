// Test: exact Bit.com signing logic from their Python SDK
// str_to_sign = api_path + "&" + encode_object(params)
// signature = HMAC-SHA256(str_to_sign, secret).hex()
import { createHmac } from 'crypto';

const host = 'https://mapi.matrixport.com';

function encodeObject(obj) {
  const sortedKeys = Object.keys(obj).sort();
  const retList = [];
  for (const key of sortedKeys) {
    const val = obj[key];
    if (Array.isArray(val)) {
      const listVal = val.map(item => typeof item === 'object' ? encodeObject(item) : String(item));
      retList.push(`${key}=[${listVal.join('&')}]`);
    } else if (typeof val === 'object' && val !== null) {
      retList.push(`${key}=${encodeObject(val)}`);
    } else if (typeof val === 'boolean') {
      retList.push(`${key}=${val ? 'true' : 'false'}`);
    } else {
      retList.push(`${key}=${val}`);
    }
  }
  retList.sort();
  return retList.join('&');
}

function sign(apiPath, params, secret) {
  const encoded = encodeObject(params);
  const strToSign = apiPath + '&' + encoded;
  return {
    sig: createHmac('sha256', secret).update(strToSign).digest('hex'),
    strToSign,
    encoded
  };
}

export default async function handler(req, res) {
  const apiKey = (process.env.BIT_API_KEY || '').trim();
  const apiSecret = (process.env.BIT_API_SECRET || '').trim();
  const tsMs = String(Date.now());
  const tsInt = Date.now();  // integer, not string
  const results = {};

  // Different path formats to try
  const paths = [
    '/trader/v2/api/symbols-info',
    '/mapi/trader/v2/api/symbols-info',
    '/v2/api/symbols-info',
    '/symbols-info',
  ];

  // Different timestamp formats
  const timestamps = [
    { label: 'strMs', val: tsMs },
    { label: 'intMs', val: tsInt },
    { label: 'intSec', val: Math.floor(tsInt / 1000) },
  ];

  for (const path of paths) {
    for (const ts of timestamps) {
      const params = { timestamp: ts.val };
      const { sig, strToSign, encoded } = sign(path, params, apiSecret);
      const label = `${path.replace(/\//g, '_')}_${ts.label}`;

      try {
        // The actual URL always hits the same endpoint
        const url = `${host}/trader/v2/api/symbols-info?timestamp=${ts.val}&signature=${sig}`;
        const r = await fetch(url, {
          headers: { 'Content-Type': 'application/json', 'X-Bit-Access-Key': apiKey }
        });
        const d = await r.json();
        results[label] = { code: d.code, msg: d.message, strToSign };
        if (d.success || d.code === 0) results[label].SUCCESS = true;
      } catch (e) { results[label] = { err: e.message }; }
    }
  }

  // Also test: maybe the URL should be betaapi.bitexch.dev or api.bit.com
  const altHosts = [
    'https://api.bit.com',
    'https://betaapi.bitexch.dev',
  ];
  for (const h of altHosts) {
    const params = { timestamp: tsInt };
    const path = '/um/v1/symbols-info';
    const { sig } = sign(path, params, apiSecret);
    try {
      const url = `${h}${path}?timestamp=${tsInt}&signature=${sig}`;
      const r = await fetch(url, {
        headers: { 'Content-Type': 'application/json', 'X-Bit-Access-Key': apiKey }
      });
      const text = await r.text();
      results[`alt_${h.replace(/https?:\/\//, '')}_um_v1`] = text.substring(0, 200);
    } catch (e) { results[`alt_${h.replace(/https?:\/\//, '')}`] = 'err:' + e.message; }
  }

  // Test: api.bit.com/trader/v2/api/symbols-info
  {
    const params = { timestamp: tsInt };
    const path = '/trader/v2/api/symbols-info';
    const { sig } = sign(path, params, apiSecret);
    try {
      const url = `https://api.bit.com${path}?timestamp=${tsInt}&signature=${sig}`;
      const r = await fetch(url, {
        headers: { 'Content-Type': 'application/json', 'X-Bit-Access-Key': apiKey }
      });
      const text = await r.text();
      results['api.bit.com_trader_v2'] = text.substring(0, 200);
    } catch (e) { results['api.bit.com_trader_v2'] = 'err:' + e.message; }
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json({ tsMs, totalTests: Object.keys(results).length, results });
}
