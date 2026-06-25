'use strict';

// waba-pulse — stub-вебхук Meta-пульса (этап 1 backlog waba-connect).
// Цель: снять СЫРОЙ payload реального входящего WhatsApp-сообщения для таблицы
// маппинга типов. НЕ боевой шлюз. Plain Node, без зависимостей (выбрасываемый сервис).
//
// Контракт:
//   GET  /webhook  — verify-handshake Meta (hub.mode/hub.verify_token/hub.challenge)
//   POST /webhook  — приём + валидация X-Hub-Signature-256 + дамп сырья ДО ветвления
//   GET  /health   — 200 ok (зеркалит /health concierge-bot)

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT) || 3000;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || '';
const APP_SECRET = process.env.META_APP_SECRET || '';

// База дампа фиксирована контрактом (/data/meta-pulse). DUMP_DIR-override — только
// для локального smoke (в контейнере переменная не задаётся → дефолт по контракту).
const DUMP_DIR = process.env.DUMP_DIR || '/data/meta-pulse';
fs.mkdirSync(DUMP_DIR, { recursive: true });

// Собрать сырое тело в Buffer ДО любого парсинга — подпись считается байт-в-байт.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// constant-time сравнение; разная длина буферов → timingSafeEqual бросает → false.
function safeEqual(a, b) {
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function dumpFilename(iso) {
  // ISO-ts содержит ':' — санитизируем в '-' (хрупко при копировании, ext4-портабельность).
  return `${iso.replace(/:/g, '-')}.json`;
}

async function handlePost(req, res) {
  const rawBody = await readRawBody(req);

  const computedSig =
    'sha256=' +
    crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  const receivedSig = req.headers['x-hub-signature-256'] || '';
  const signatureValid = safeEqual(computedSig, receivedSig);

  let parsed = null;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    parsed = null;
  }

  const receivedAt = new Date().toISOString();
  const record = {
    receivedAt,
    method: req.method,
    headers: req.headers,
    rawBody: rawBody.toString('utf8'),
    receivedSig,
    computedSig,
    signatureValid,
    parsed,
  };

  // Дамп ДО ветвления: баг в подписи не должен потерять payload.
  try {
    const file = path.join(DUMP_DIR, dumpFilename(receivedAt));
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    console.log(`[waba-pulse] dumped ${file} signatureValid=${signatureValid}`);
  } catch (err) {
    console.error('[waba-pulse] dump failed:', err);
  }

  if (signatureValid) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('EVENT_RECEIVED');
  } else {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('invalid signature');
  }
}

function handleGetWebhook(url, res) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(challenge == null ? '' : challenge); // challenge как есть, без кавычек/JSON
  } else {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (pathname === '/webhook') {
    if (req.method === 'GET') {
      handleGetWebhook(url, res);
      return;
    }
    if (req.method === 'POST') {
      handlePost(req, res).catch((err) => {
        console.error('[waba-pulse] POST handler error:', err);
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('error');
      });
      return;
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`[waba-pulse] listening on :${PORT}, dumps → ${DUMP_DIR}`);
});
