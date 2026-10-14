// server.mjs
// Servidor local de pruebas. Usa exactamente el mismo backend que la Lambda.
// Arrancar con: npm run dev

import dotenv from 'dotenv';
dotenv.config();

const { default: app } = await import('./app.mjs');

/**
 * Puerto utilizado por el servidor local.
 * Se obtiene de la variable de entorno PORT o utiliza 3000 por defecto.
 *
 * @type {number}
 */
const PORT = Number(process.env.PORT) || 3000;

/**
 * Inicia el servidor HTTP local de RIETI para desarrollo y pruebas.
 *
 * Utiliza la misma instancia de Express que posteriormente se ejecuta
 * en AWS Lambda, permitiendo probar el backend localmente sin mantener
 * dos implementaciones distintas.
 */
app.listen(PORT, () => {
  console.log(`Servidor local RIETI escuchando en http://localhost:${PORT}`);
  console.log(`Prueba: http://localhost:${PORT}/health`);
});