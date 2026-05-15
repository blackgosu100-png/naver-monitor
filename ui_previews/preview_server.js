const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT || 5010);

http.createServer((req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const filePath = path.join(root, pathname === '/' ? 'stock_restock_estimation_candidates.html' : pathname.replace(/^\/+/, ''));

  fs.readFile(filePath, (err, body) => {
    if (err) {
      res.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
      res.end('not found');
      return;
    }
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    res.end(body);
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`Preview server: http://127.0.0.1:${port}/stock_restock_estimation_candidates.html`);
});
