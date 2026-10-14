# RIETI Backend

Backend del sistema RIETI, desarrollado con Node.js y Express.

El servidor expone una API REST utilizada por la aplicación móvil y el portal web administrativo. La API permite registrar y consultar reportes, gestionar evidencias, autenticar funcionarios, administrar usuarios, atender casos, realizar transferencias y obtener información para el dashboard.

El proyecto puede ejecutarse de dos formas:

- Localmente, mediante un servidor de Express.
- En la nube, mediante AWS Lambda.

Ambas formas utilizan exactamente la misma lógica definida en `app.mjs`.

---

## Tecnologías utilizadas

- Node.js
- JavaScript con ES Modules
- Express.js
- MySQL
- Amazon RDS
- Amazon S3
- AWS Lambda
- JSON Web Tokens (JWT)
- bcrypt
- AWS SDK

Principales dependencias del proyecto:

- `express`
- `cors`
- `mysql2`
- `jsonwebtoken`
- `bcryptjs`
- `serverless-http`
- `dotenv`
- `@aws-sdk/client-s3`
- `@aws-sdk/s3-request-presigner`

---

# Arquitectura general

El backend funciona como intermediario entre los clientes del sistema y los servicios de almacenamiento.

```text
Aplicación móvil / Portal web
            |
          HTTPS
            |
            v
      API REST RIETI
     Node.js + Express
            |
      +-----+------+
      |            |
      v            v
Amazon RDS      Amazon S3
   MySQL        Evidencias
```

La aplicación móvil y el portal web nunca acceden directamente a la base de datos.

Todas las operaciones se realizan mediante los endpoints definidos en el backend.

Amazon RDS se utiliza para almacenar la información estructurada del sistema, mientras que Amazon S3 se utiliza para almacenar las evidencias fotográficas.

---

# Organización del repositorio

La estructura principal del proyecto es la siguiente:

```text
rieti-backend/
│
├── db/
│   ├── migrar_password_bcrypt.sql
│   ├── schema_rieti.sql
│   └── seed_pruebas.sql
│
├── tools/
│   └── probador_endpoints.html
│
├── node_modules/
│
├── .env
├── .env.example
├── .gitignore
│
├── app.mjs
├── lambda.mjs
├── server.mjs
│
├── package.json
├── package-lock.json
│
└── README.md
```

## Archivos principales

### `app.mjs`

Es el archivo principal del backend.

Contiene:

- configuración de Express;
- conexión con Amazon RDS;
- configuración de Amazon S3;
- middleware de autenticación;
- validación de JWT;
- control de roles;
- rutas públicas;
- manejo de evidencias;
- autenticación;
- administración de usuarios;
- bandeja de reportes;
- atención de casos;
- asignaciones;
- transferencias;
- dashboard;
- manejo de errores.

Toda la lógica principal del backend se mantiene en este archivo para que tanto la versión local como la versión desplegada en AWS utilicen exactamente la misma implementación.

---

### `lambda.mjs`

Es el punto de entrada utilizado por AWS Lambda.

Utiliza `serverless-http` para adaptar la aplicación Express definida en `app.mjs` al entorno de ejecución de AWS Lambda.

```js
import serverless from 'serverless-http';
import app from './app.mjs';

export const handler = serverless(app);
```

El handler configurado en AWS Lambda debe ser:

```text
lambda.handler
```

---

### `server.mjs`

Permite ejecutar localmente el mismo backend utilizado por AWS Lambda.

Carga las variables de entorno mediante `dotenv`, importa la aplicación definida en `app.mjs` e inicia un servidor HTTP.

Por defecto utiliza el puerto:

```text
3000
```

aunque puede modificarse mediante la variable de entorno `PORT`.

---

# Carpeta `db`

Contiene los scripts SQL necesarios para crear y preparar la base de datos.

## `db/schema_rieti.sql`

Contiene la estructura principal de la base de datos RIETI.

Define las tablas, relaciones, llaves primarias, llaves foráneas y demás elementos necesarios para almacenar la información del sistema.

Debe ejecutarse al crear una nueva instancia de la base de datos.

---

## `db/seed_pruebas.sql`

Contiene datos utilizados durante el desarrollo y las pruebas.

Permite insertar registros iniciales como usuarios, roles, catálogos u otros datos necesarios para probar el backend.

No representa información real de producción.

---

## `db/migrar_password_bcrypt.sql`

Script utilizado durante la adaptación del sistema para almacenar contraseñas mediante hashes compatibles con bcrypt.

Se conserva como parte del historial de cambios de la base de datos y no es necesario ejecutarlo al crear una base nueva utilizando el esquema actualizado.

---

# Carpeta `tools`

Contiene herramientas utilizadas durante el desarrollo y las pruebas.

## `tools/probador_endpoints.html`

Interfaz HTML utilizada para probar manualmente los diferentes endpoints del backend.

Permite realizar operaciones como:

- comprobar el estado del servidor;
- consultar catálogos;
- registrar reportes;
- consultar folios;
- subir evidencias;
- iniciar sesión;
- probar rutas administrativas;
- gestionar usuarios;
- realizar asignaciones;
- registrar actuaciones;
- realizar transferencias;
- consultar información del dashboard.

Esta herramienta es únicamente de desarrollo y pruebas. No forma parte del frontend final de RIETI.

---

# Archivos de configuración

## `.env`

Contiene las variables de entorno utilizadas durante la ejecución local.

Este archivo puede incluir información sensible, por lo que no debe subirse al repositorio público.

Ejemplo:

```env
DB_HOST=host-de-rds
DB_USER=usuario
DB_PASSWORD=contraseña
DB_NAME=rieti
DB_PORT=3306

AWS_REGION=us-east-1
S3_BUCKET_NAME=nombre-del-bucket

JWT_SECRET=secreto-jwt

PORT=3000
```

---

## `.env.example`

Sirve como referencia de las variables que necesita el proyecto.

No debe contener contraseñas, secretos ni credenciales reales.

Para configurar el proyecto localmente se puede copiar este archivo:

```bash
cp .env.example .env
```

y posteriormente colocar los valores correspondientes.

---

## `.gitignore`

Indica los archivos y carpetas que Git no debe incluir en el repositorio.

Entre ellos deben encontrarse:

```text
node_modules/
.env
```

Esto evita subir dependencias generadas automáticamente y credenciales privadas.

---

## `package.json`

Define la información del proyecto, sus dependencias y los scripts disponibles para ejecutarlo.

---

## `package-lock.json`

Registra las versiones exactas de las dependencias utilizadas.

Permite que diferentes integrantes del equipo instalen las mismas versiones de los paquetes.

---

# Ejecución local

## 1. Requisitos

Para ejecutar el backend localmente se requiere:

- Node.js instalado;
- acceso a una base de datos MySQL compatible con el esquema de RIETI;
- variables de entorno correctamente configuradas;
- acceso a AWS S3 si se desean probar las evidencias.

---

## 2. Instalar dependencias

Desde la carpeta raíz del proyecto ejecutar:

```bash
npm install
```

Esto instalará las dependencias declaradas en `package.json`.

No es necesario compartir la carpeta `node_modules`.

---

## 3. Configurar variables de entorno

Crear un archivo:

```text
.env
```

tomando como referencia:

```text
.env.example
```

Ejemplo:

```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=password
DB_NAME=rieti
DB_PORT=3306

AWS_REGION=us-east-1
S3_BUCKET_NAME=rieti-evidencias

JWT_SECRET=secreto_local

PORT=3000
```

---

## 4. Preparar la base de datos

Crear la base de datos utilizando:

```text
db/schema_rieti.sql
```

Si se requieren datos de prueba también se puede ejecutar:

```text
db/seed_pruebas.sql
```

---

## 5. Iniciar el servidor

Ejecutar:

```bash
npm run dev
```

El servidor se iniciará normalmente en:

```text
http://localhost:3000
```

Para comprobar que está funcionando:

```text
http://localhost:3000/health
```

La respuesta debe ser similar a:

```json
{
  "ok": true,
  "db_host": "configurado",
  "db_name": "rieti",
  "bucket": "rieti-evidencias"
}
```

---

# Ejecución en AWS Lambda

El mismo código puede ejecutarse en AWS Lambda sin modificar la lógica de `app.mjs`.

La diferencia es que AWS utiliza `lambda.mjs` como punto de entrada.

## 1. Preparar el proyecto

El paquete que se despliegue debe contener, como mínimo:

```text
app.mjs
lambda.mjs
package.json
package-lock.json
node_modules/
```

> **Nota:** La carpeta `node_modules` no se almacena en el repositorio.  
> Antes de preparar el archivo ZIP que se desplegará en AWS Lambda, se debe ejecutar `npm install` desde la raíz del proyecto para instalar las dependencias y generar la carpeta `node_modules`.

`server.mjs` puede permanecer dentro del proyecto, aunque no es utilizado por Lambda.

Los scripts SQL y herramientas de pruebas tampoco son necesarios para la ejecución de Lambda.

---

## 2. Configurar el handler

Dentro de la configuración de AWS Lambda se debe establecer:

```text
lambda.handler
```

Esto corresponde a:

```js
export const handler = serverless(app);
```

definido dentro de `lambda.mjs`.

---

## 3. Configurar variables de entorno

En AWS Lambda deben configurarse las mismas variables necesarias por `app.mjs`.

```text
DB_HOST
DB_USER
DB_PASSWORD
DB_NAME
DB_PORT
AWS_REGION
S3_BUCKET_NAME
JWT_SECRET
```

La variable `PORT` no es necesaria dentro de Lambda.

---

## 4. Configurar Amazon RDS

La función Lambda debe poder establecer conexión con la instancia de Amazon RDS utilizada por RIETI.

La base debe contener el esquema definido en:

```text
db/schema_rieti.sql
```

La API utiliza conexiones MySQL mediante `mysql2/promise`.

---

## 5. Configurar Amazon S3

Debe existir un bucket de Amazon S3 utilizado para almacenar las evidencias.

Su nombre se configura mediante:

```text
S3_BUCKET_NAME
```

La función Lambda necesita permisos para realizar las operaciones necesarias sobre el bucket.

El backend utiliza URLs prefirmadas para que los clientes puedan subir evidencias sin recibir credenciales de AWS.

---

## 6. Crear una Function URL

AWS Lambda puede exponerse mediante una Function URL.

Esta dirección funciona como URL base de la API.

Ejemplo:

```text
https://xxxxxxxx.lambda-url.us-east-1.on.aws
```

Una vez configurada, se puede comprobar el backend visitando:

```text
https://xxxxxxxx.lambda-url.us-east-1.on.aws/health
```

---

# Funcionamiento de las evidencias

Las imágenes no se almacenan directamente dentro de MySQL.

El proceso es:

```text
1. El frontend registra un reporte.

2. El backend devuelve el folio.

3. El frontend solicita una URL prefirmada.

4. El backend genera una URL temporal de Amazon S3.

5. El frontend realiza un PUT de la imagen directamente a S3.

6. El frontend confirma la carga al backend.

7. El backend registra en MySQL la ruta del archivo.
```

La tabla `evidencia` almacena información como:

```text
idEvidencia
folio
ruta_s3
fecha_carga
fecha_purga
```

De esta forma, MySQL conserva la relación entre el reporte y la evidencia, mientras que el archivo se almacena físicamente en Amazon S3.

---

# Autenticación

Las rutas administrativas utilizan JSON Web Tokens.

El usuario inicia sesión mediante:

```text
POST /api/v1/auth/login
```

Si las credenciales son correctas, el backend genera un token JWT.

Las solicitudes posteriores a rutas protegidas deben incluir:

```http
Authorization: Bearer <token>
```

El backend verifica el token antes de permitir el acceso.

Actualmente existen principalmente dos perfiles:

- Administrador.
- Alimentador.

El Administrador dispone de permisos de mayor alcance, mientras que el Alimentador tiene acceso limitado principalmente a los reportes correspondientes a su municipio.

---

# Endpoints principales

## Estado del servidor

```text
GET /health
```

---

## Catálogos

```text
GET /api/v1/catalogos/actividades
GET /api/v1/municipios
```

---

## Reportes ciudadanos

```text
POST /api/v1/reportes
GET  /api/v1/reportes/:folio
```

---

## Evidencias

```text
POST /api/v1/evidencias/presigned-url
POST /api/v1/evidencias/confirmar
POST /api/v1/evidencias/url-lectura
```

---

## Autenticación

```text
POST /api/v1/auth/login
GET  /api/v1/auth/me
POST /api/v1/auth/password
```

---

## Administración de usuarios

```text
POST  /api/v1/admin/usuarios
GET   /api/v1/admin/usuarios
PATCH /api/v1/admin/usuarios/:id
PATCH /api/v1/admin/usuarios/:id/estado
```

---

## Gestión de reportes

```text
GET  /api/v1/admin/reportes
GET  /api/v1/admin/reportes/:folio/expediente

POST /api/v1/admin/asignaciones
POST /api/v1/admin/atencion
POST /api/v1/admin/transferencias
```

---

## Dashboard

```text
GET /api/v1/admin/dashboard/resumen
GET /api/v1/admin/dashboard/estadisticas
```

---

# Seguridad

El backend incorpora diferentes mecanismos de seguridad:

- autenticación mediante JWT;
- control de acceso basado en roles;
- restricción de información por municipio;
- almacenamiento de contraseñas mediante bcrypt;
- consultas SQL parametrizadas;
- validación de datos en el servidor;
- separación de rutas públicas y administrativas;
- uso de HTTPS en AWS;
- almacenamiento privado de evidencias en S3;
- URLs prefirmadas para acceso temporal a archivos;
- generación de hashes SHA-256 para información de reportes.

Algunas medidas adicionales, como rate limiting, bloqueo por múltiples intentos fallidos de autenticación y configuraciones de CORS más restrictivas, pueden incorporarse antes de utilizar el sistema en un entorno productivo.

---

# Pruebas

Para realizar pruebas manuales puede utilizarse:

```text
tools/probador_endpoints.html
```

El archivo permite enviar solicitudes a la API y visualizar:

- método HTTP;
- URL utilizada;
- cuerpo enviado;
- código de respuesta;
- tiempo de respuesta;
- JSON recibido.

Para pruebas locales debe configurarse la URL base como:

```text
http://localhost:3000
```

Para pruebas en AWS debe utilizarse la Function URL correspondiente.

---

# Flujo de desarrollo

El proyecto utiliza el mismo archivo `app.mjs` en ambos entornos:

```text
                    app.mjs
                       |
            +----------+----------+
            |                     |
            v                     v
       server.mjs             lambda.mjs
            |                     |
            v                     v
      Entorno local           AWS Lambda
```

Esto evita mantener dos versiones diferentes del backend y permite probar localmente la misma lógica que posteriormente se ejecuta en AWS.

---

# RIETI

RIETI es un proyecto desarrollado para **SIPINNA** como parte del reto de la materia **Integración de seguridad informática en redes y sistemas de software** del **Instituto Tecnológico y de Estudios Superiores de Monterrey (ITESM)**.

La solución será probada e integrada mediante una **aplicación móvil** y un **panel web administrativo** desarrollados por el equipo, los cuales consumirán los servicios expuestos por este backend para validar el funcionamiento completo del sistema.

Esta parte correspondiente al **backend** fue desarrollada por los alumnos:

- **Luis Alejandro Olvera Hernández**
- **Valeria Gisselle Portilla Robles**