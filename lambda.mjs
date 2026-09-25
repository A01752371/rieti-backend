// lambda.mjs
// Punto de entrada para AWS Lambda. Toda la lógica vive en app.mjs.

import serverless from 'serverless-http';
import app from './app.mjs';

export const handler = serverless(app);
