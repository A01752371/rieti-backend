// lambda.mjs
// Punto de entrada para AWS Lambda. Toda la lógica vive en app.mjs.

import serverless from 'serverless-http';
import app from './app.mjs';

/**
 * Handler principal de AWS Lambda.
 *
 * Adapta la aplicación Express definida en app.mjs para que pueda
 * ejecutarse dentro del entorno serverless de AWS Lambda.
 *
 * @type {import('aws-lambda').Handler}
 */
export const handler = serverless(app);