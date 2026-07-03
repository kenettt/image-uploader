const http = require('http');
const HOST = '192.168.1.151'; // <- pane siia Wi‑Fi IP
const PORT = 8000;

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Hello World');
});

server.listen(PORT, HOST, () => {
  console.log(`Server kuulab ainult aadressil http://${HOST}:${PORT}`);
});