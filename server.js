// Dev server: static files + CORS proxy for GitHub release downloads
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8085;
const WWW = path.join(__dirname, 'www');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.py': 'text/x-python', '.pl': 'text/plain',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.zip': 'application/zip', '.map': 'application/json', '.srwb': 'application/json',
};

function followRedirects(url, callback, maxRedirects = 5) {
  if (maxRedirects <= 0) return callback(new Error('Too many redirects'));
  https.get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      followRedirects(res.headers.location, callback, maxRedirects - 1);
    } else {
      callback(null, res);
    }
  }).on('error', callback);
}

http.createServer((req, res) => {
  // CORS proxy: /proxy?url=https://github.com/...
  if (req.url.startsWith('/proxy?url=')) {
    const target = decodeURIComponent(req.url.slice('/proxy?url='.length));

    // Only allow GitHub release downloads
    if (!target.startsWith('https://github.com/') || !target.includes('/releases/download/')) {
      res.writeHead(403);
      res.end('Proxy only allows GitHub release downloads');
      return;
    }

    followRedirects(target, (err, upstream) => {
      if (err) {
        res.writeHead(502);
        res.end('Proxy error: ' + err.message);
        return;
      }
      res.writeHead(upstream.statusCode, {
        'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
        'Content-Length': upstream.headers['content-length'] || '',
        'Access-Control-Allow-Origin': '*',
      });
      upstream.pipe(res);
    });
    return;
  }

  // Static file server
  const requestPath = req.url.split('?')[0];
  let filePath = path.join(WWW, requestPath === '/' ? 'index.html' : requestPath);
  filePath = path.normalize(filePath);

  // Security: don't serve files outside www/
  if (!filePath.startsWith(WWW)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}).listen(PORT, () => {
  console.log(`SciREPL dev server: http://localhost:${PORT}/`);
  console.log(`CORS proxy:         http://localhost:${PORT}/proxy?url=...`);
});
