// servir_panel.mjs
// Levanta un servidor local para abrir probador_endpoints.html con una
// direccion http:// en lugar de doble clic, que es lo que pide el CORS
// del backend. No necesita instalar nada: solo usa lo que ya trae Node.
//
// Correr con:  node servir_panel.mjs
// Detener con: Ctrl+C

import http from 'http';
import fs from 'fs';
import path from 'path';

const PUERTO = 5500;
const INICIO = '/probador_endpoints.html';

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const RAIZ = process.cwd();

const servidor = http.createServer((req, res) => {
  const pedido = decodeURIComponent(req.url.split('?')[0]);
  const relativo = pedido === '/' ? INICIO : pedido;
  const archivo = path.resolve(RAIZ, '.' + relativo);

  // No servir nada fuera de la carpeta
  if (!archivo.startsWith(RAIZ)) {
    res.writeHead(403);
    return res.end('Fuera de la carpeta');
  }

  fs.readFile(archivo, (err, datos) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No se encontro: ' + relativo);
    }
    res.writeHead(200, {
      'Content-Type': TIPOS[path.extname(archivo).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(datos);
  });
});

servidor.listen(PUERTO, () => {
  console.log('');
  console.log('  Panel listo. Abre esta direccion en el navegador:');
  console.log('');
  console.log('      http://localhost:' + PUERTO + INICIO);
  console.log('');
  console.log('  Para detener el servidor: Ctrl+C');
  console.log('');
});
