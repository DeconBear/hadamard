// Echo Manim renderer used by the example + E2E tests.
// Run: node examples/hcanvas-extensions/manim-http/renderer/echo_renderer.mjs
// POST /render {scene, quality} -> {ok:true, artifacts:[{mime:"image/svg+xml", dataBase64}]}
import { createServer } from 'node:http';

const PORT = Number(process.env.MANIM_ECHO_PORT || 8765);
const server = createServer(async (req, res) => {
  console.error('[echo] ' + req.method + ' ' + req.url);
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'hcanvas-manim-echo' }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/render')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* keep empty */ }
  const scene = typeof body.scene === 'string' ? body.scene : '';
  const quality = typeof body.quality === 'string' ? body.quality : 'medium';
  const title = escapeXml((scene.split('\n')[0] || 'Manim scene').slice(0, 64));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect width="960" height="540" fill="#f6f4ef"/>
  <circle cx="480" cy="250" r="130" fill="none" stroke="#6657D9" stroke-width="6"/>
  <text x="480" y="258" text-anchor="middle" font-family="Georgia, serif" font-size="30" fill="#1f2430">Manim echo render</text>
  <text x="480" y="300" text-anchor="middle" font-family="Inter, sans-serif" font-size="16" fill="#6b7280">${title}</text>
  <text x="480" y="470" text-anchor="middle" font-family="Inter, sans-serif" font-size="14" fill="#8a8276">quality: ${escapeXml(quality)} · replace this service with your own renderer</text>
</svg>`;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, artifacts: [{ mime: 'image/svg+xml', dataBase64: Buffer.from(svg, 'utf8').toString('base64') }] }));
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ ok: true, url: 'http://127.0.0.1:' + PORT + '/render', pid: process.pid }));
});

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}