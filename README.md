# rieti-backend

Backend del sistema RIETI para el reporte ciudadano de trabajo infantil.

## Estructura

```
app.mjs                 Toda la lógica del backend (rutas, validaciones, acceso a datos)
lambda.mjs              Punto de entrada para AWS Lambda
server.mjs              Punto de entrada para correr en local
db/schema_rieti.sql     Estructura de la base de datos
db/seed_pruebas.sql     Datos ficticios para probar
.env.example            Plantilla de variables de entorno
```

`app.mjs` es el único lugar donde se escriben rutas. Lambda y el servidor local
solo la envuelven, así las dos versiones nunca se separan.

## Correr en local

```bash
npm install
cp .env.example .env     # y llenar los valores
npm run dev
```

Luego abrir http://localhost:3000/health

## Desplegar en AWS Lambda

1. `npm install`
2. Comprimir `app.mjs`, `lambda.mjs`, `package.json` y `node_modules` en un zip
   (seleccionar los cuatro elementos, no la carpeta que los contiene).
3. En la consola de Lambda: **Code → Upload from → .zip file**.
4. Verificar en **Runtime settings** que el Handler sea `lambda.handler`.
5. Configurar las variables de entorno de la función: `DB_HOST`, `DB_PORT`,
   `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `JWT_SECRET`, `S3_BUCKET_NAME`.
6. Timeout en 30 segundos (**Configuration → General configuration**).

El `.env` no viaja en el zip y Lambda no lo lee. Las variables se configuran
en la consola.

## Base de datos

Para instalar desde cero, en DBeaver:

1. `db/schema_rieti.sql` — crea las tablas y los catálogos base.
2. `db/seed_pruebas.sql` — opcional, llena datos de prueba.

**Cuidado:** `schema_rieti.sql` empieza con `DROP DATABASE`, así que borra todo
lo que haya. Solo correrlo para instalar desde cero.

`seed_pruebas.sql` sí se puede correr las veces que se quiera: vacía las tablas
transaccionales antes de volver a llenarlas.

## Endpoints

### Públicos

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Verifica que el servicio responde |
| GET | `/api/v1/catalogos/actividades` | Catálogo de actividades laborales |
| GET | `/api/v1/municipios` | Municipios adheridos a la red |
| POST | `/api/v1/reportes` | Registrar un reporte y obtener folio |
| GET | `/api/v1/reportes/:folio` | Consultar estatus por folio |
| POST | `/api/v1/evidencias/presigned-url` | URL firmada para subir una foto a S3 |
| POST | `/api/v1/evidencias/confirmar` | Vincular la foto subida con el reporte |

### Autenticación

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/v1/auth/login` | Inicio de sesión, devuelve token JWT |
| GET | `/api/v1/auth/me` | Datos del usuario autenticado |

### Administrativos (requieren token)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/v1/admin/reportes` | Bandeja de reportes. Acepta `?estatus=` y `?prioridad=` |
| GET | `/api/v1/admin/reportes/:folio/expediente` | Expediente completo con bitácora e historial |
| POST | `/api/v1/admin/atencion` | Registrar actuación y cambiar estatus |
| POST | `/api/v1/admin/transferencias` | Transferencia, canalización a PPNNA o descarte |

El rol Alimentador solo ve y atiende reportes de su municipio. Las
transferencias y canalizaciones son exclusivas del rol Administrador.

## Estatus válidos del reporte

`Recibido`, `En Revision`, `En Proceso`, `Concluido`, `Reincidencia`,
`Canalizado`, `Cancelado`.

Cualquier cambio de estatus exige justificación y queda asentado en
`historial_estatus`.

## Pendiente

- El login compara la contraseña en texto plano. Antes de liberar hay que
  guardarla con bcrypt y usar `bcrypt.compare` (RNF-31).
- Falta el envío de correo por SES al generar folio y al cambiar estatus
  (RF-09, RNF-19). La tabla `notificacion` ya está lista para registrarlo.
- Falta la limpieza de metadatos EXIF de las imágenes antes de guardarlas
  en S3 (RNF-32).
