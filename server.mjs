// server.mjs
// Servidor local de pruebas. Usa exactamente el mismo backend que la Lambda.
// Arrancar con: npm run dev

import dotenv from 'dotenv';
dotenv.config();

const { default: app } = await import('./app.mjs');

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`Servidor local RIETI escuchando en http://localhost:${PORT}`);
  console.log(`Prueba: http://localhost:${PORT}/health`);
});
