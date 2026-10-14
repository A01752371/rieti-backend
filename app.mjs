// app.mjs
// Toda la lógica del backend RIETI vive aquí.
// lambda.mjs la envuelve para AWS Lambda y server.mjs la levanta en local,
// así las dos versiones nunca se desincronizan.

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const app = express();

// Detrás de la Function URL de Lambda la IP real del cliente llega en
// X-Forwarded-For. Sin esto el rate limiter vería una sola IP interna.
app.set('trust proxy', 1);

// Orígenes que pueden llamar la API desde un navegador. Con cookies de sesión
// (credentials: true) el navegador rechaza el origen '*', así que hay lista.
//
// Los puertos locales son los que usan las herramientas de desarrollo del
// equipo: 5173 Vite, 3000 Next/CRA, 5500 Live Server de VS Code, 8080 otros.
// Sirven para abrir el panel de pruebas y el front en la máquina de cada quien.
const PUERTOS_LOCALES = [5173, 3000, 5500, 8080];

const ORIGENES_LOCALES = PUERTOS_LOCALES.flatMap((p) => [
  `http://localhost:${p}`,
  `http://127.0.0.1:${p}`
]);

// CORS_EXTRA_ORIGINS permite agregar orígenes sin volver a desplegar.
// Normalmente va vacía.
const ORIGENES_PERMITIDOS = [
  ...ORIGENES_LOCALES,
  process.env.FRONTEND_WEB_URL,
  ...(process.env.CORS_EXTRA_ORIGINS || '').split(',').map((o) => o.trim())
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Sin cabecera Origin: app móvil nativa, curl o Postman. CORS no aplica.
    if (!origin) return callback(null, true);
    callback(null, ORIGENES_PERMITIDOS.includes(origin));
  },
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());

// Si la API se expone por API Gateway, el path llega con el stage y el recurso
// al inicio (/default/rieti-backend/api/v1/...). Con Function URL y en local
// llega limpio. Este middleware recorta el prefijo solo cuando existe.
app.use((req, res, next) => {
  const i = req.url.indexOf('/api/v1');
  if (i > 0) {
    req.url = req.url.slice(i);
  } else if (req.url.includes('/health')) {
    req.url = '/health';
  }
  next();
});

// =========================================================================
// CONFIGURACIÓN
// =========================================================================

// Sin secreto la función no arranca, en lugar de firmar con una clave conocida.
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('Falta la variable de entorno JWT_SECRET');
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: false // Requerido por AWS RDS si se usa SSL/TLS
  }
});

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET_NAME = process.env.S3_BUCKET_NAME;

// Costo de bcrypt. Más alto = más lento de romper, pero también de validar.
const BCRYPT_ROUNDS = 10;

// Longitud mínima de contraseña
const MIN_PASSWORD = 8;

// Longitud máxima de los campos de texto libre del reporte.
// Debe coincidir con VARCHAR de la base (db/migrar_limites_campos.sql).
const MAX_DESCRIPCION = 500;
const MAX_REFERENCIAS = 100;

// Estatus válidos del reporte. Deben coincidir con el catálogo del diseño.
const ESTATUS = {
  RECIBIDO: 'Recibido',
  EN_REVISION: 'En Revision',
  EN_PROCESO: 'En Proceso',
  CONCLUIDO: 'Concluido',
  REINCIDENCIA: 'Reincidencia',
  CANALIZADO: 'Canalizado',
  CANCELADO: 'Cancelado'
};

// Rate limiting del login (RNF-07): 10 intentos por IP cada 15 minutos.
// El contador vive en la memoria de la instancia de Lambda, así que el límite
// es por contenedor y no global. Es una primera barrera, no una garantía.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Demasiados intentos de inicio de sesión. Intente nuevamente más tarde.'
  }
});

// =========================================================================
// MIDDLEWARE DE AUTENTICACIÓN (JWT)
// =========================================================================

const verificarToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];

  const bearerToken = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : null;

  // El panel web manda el token en cookie HttpOnly, la app móvil en cabecera.
  // Las mismas rutas sirven a los dos clientes.
  const token = (req.cookies && req.cookies.rieti_token) || bearerToken;

  if (!token) {
    return res.status(401).json({ error: 'Acceso denegado. Token no proporcionado.' });
  }

  let decoded;

  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return res.status(403).json({ error: 'Token inválido o expirado.' });
  }

  try {
    // El token dura 8 horas, pero una cuenta desactivada tiene que dejar de
    // entrar de inmediato, así que el estado se revisa en cada petición.
    const [rows] = await pool.query(
      'SELECT activo FROM usuario WHERE idUsuario = ?',
      [decoded.idUsuario]
    );

    if (rows.length === 0 || !rows[0].activo) {
      return res.status(403).json({ error: 'La cuenta está inactiva' });
    }

    req.usuario = decoded;
    next();
  } catch (error) {
    return res.status(500).json({ error: 'Error al validar la sesión', detalle: error.message });
  }
};

// Solo el rol Administrador (idRol 1) puede ejecutar la acción
const soloAdministrador = (req, res, next) => {
  if (req.usuario.idRol !== 1) {
    return res.status(403).json({ error: 'Esta acción requiere perfil de Administrador' });
  }
  next();
};

// =========================================================================
// HEALTHCHECK
// =========================================================================

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    db_host: process.env.DB_HOST ? 'configurado' : 'FALTA',
    db_name: process.env.DB_NAME || 'FALTA',
    bucket: BUCKET_NAME || 'FALTA'
  });
});

// =========================================================================
// 1. RUTAS PÚBLICAS (MÓVIL Y FORMULARIO WEB)
// =========================================================================

app.get('/api/v1/catalogos/actividades', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT idCatalogoActividad, nombre FROM catalogo_actividad ORDER BY nombre ASC'
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar actividades', detalle: error.message });
  }
});

app.get('/api/v1/municipios', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT idMunicipio, nombre, siglas, clave_inegi, adherido_rieti FROM municipio ORDER BY nombre ASC'
    );

    res.json(rows);
  } catch (error) {
    res.status(500).json({
      error: 'Error al consultar municipios',
      detalle: error.message
    });
  }
});

// Registrar un nuevo reporte y generar folio con siglas (ej. RIETI-ATZ-2026-00001)
app.post('/api/v1/reportes', async (req, res) => {
  let connection;
  try {
    const {
      idMunicipio,
      idCatalogoActividad,
      descripcion,
      correo_contacto,
      latitud,
      longitud,
      modalidad,
      num_menores,
      rango_edad,
      genero_observado,
      hora_observada,
      situacion_riesgo,
      calle,
      colonia,
      cp,
      referencias,
      acepto_aviso
    } = req.body;

    // La modalidad decide si el correo es obligatorio:
    // ANONIMO     -> el ciudadano no deja correo y no recibe avisos
    // SEGUIMIENTO -> el correo es obligatorio para mandarle el folio
    const modalidadFinal = (modalidad || 'SEGUIMIENTO').toUpperCase();

    if (modalidadFinal !== 'ANONIMO' && modalidadFinal !== 'SEGUIMIENTO') {
      return res.status(400).json({
        error: 'Modalidad no válida',
        validas: ['ANONIMO', 'SEGUIMIENTO']
      });
    }

    if (modalidadFinal === 'SEGUIMIENTO' && !correo_contacto) {
      return res.status(400).json({
        error: 'El correo electrónico es obligatorio en la modalidad SEGUIMIENTO'
      });
    }

    if (!idMunicipio) {
      return res.status(400).json({ error: 'El idMunicipio es obligatorio' });
    }

    if (!idCatalogoActividad) {
      return res.status(400).json({ error: 'El idCatalogoActividad es obligatorio' });
    }

    if (latitud === undefined || latitud === null || longitud === undefined || longitud === null) {
      return res.status(400).json({ error: 'La ubicación (latitud y longitud) es obligatoria' });
    }

    if (!descripcion) {
      return res.status(400).json({ error: 'La descripción de los hechos es obligatoria' });
    }

    if (descripcion.length > MAX_DESCRIPCION) {
      return res.status(400).json({
        error: 'La descripción no puede pasar de ' + MAX_DESCRIPCION + ' caracteres',
        longitud_recibida: descripcion.length
      });
    }

    if (referencias && referencias.length > MAX_REFERENCIAS) {
      return res.status(400).json({
        error: 'Las referencias no pueden pasar de ' + MAX_REFERENCIAS + ' caracteres',
        longitud_recibida: referencias.length
      });
    }

    if (acepto_aviso !== true) {
      return res.status(400).json({ error: 'Debe aceptar el aviso de privacidad para registrar el reporte' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Bloquear el renglón del municipio para que dos reportes simultáneos
    // no tomen el mismo consecutivo
    const [munRows] = await connection.query(
      'SELECT siglas, contador FROM municipio WHERE idMunicipio = ? FOR UPDATE',
      [idMunicipio]
    );

    if (munRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Municipio no encontrado' });
    }

    const municipio = munRows[0];
    const nuevoContador = municipio.contador + 1;

    await connection.query(
      'UPDATE municipio SET contador = ? WHERE idMunicipio = ?',
      [nuevoContador, idMunicipio]
    );

    const anioActual = new Date().getFullYear();
    const consecutivo = String(nuevoContador).padStart(5, '0');
    const folio = `RIETI-${municipio.siglas}-${anioActual}-${consecutivo}`;

    // Huella de integridad del reporte (RNF-24)
    const payloadIntegridad = `${folio}|${latitud}|${longitud}|${idCatalogoActividad}|${descripcion}`;
    const hash_sha256 = crypto.createHash('sha256').update(payloadIntegridad).digest('hex');

    const horaFinal = hora_observada || new Date().toTimeString().slice(0, 8);

    // En modalidad anónima no se guarda correo aunque la app lo haya mandado
    const correoFinal = modalidadFinal === 'ANONIMO' ? null : correo_contacto;

    await connection.query(
      `INSERT INTO reporte (
         folio, modalidad, correo_contacto, num_menores, rango_edad,
         genero_observado, idCatalogoActividad, hora_observada, descripcion, situacion_riesgo,
         latitud, longitud, calle, colonia, cp, referencias, idMunicipio,
         estatus, prioridad, hash_sha256, acepto_aviso, fecha_aceptacion, fecha_registro
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        folio,
        modalidadFinal,
        correoFinal,
        num_menores || 1,
        rango_edad || 'No especificado',
        genero_observado || 'No especificado',
        idCatalogoActividad,
        horaFinal,
        descripcion,
        situacion_riesgo ? 1 : 0,
        latitud,
        longitud,
        calle || 'No especificada',
        colonia || 'No especificada',
        cp || null,
        referencias || null,
        idMunicipio,
        ESTATUS.RECIBIDO,
        situacion_riesgo ? 'Alta' : 'Media',
        hash_sha256,
        1
      ]
    );

    await connection.commit();

    res.status(201).json({
      message: 'Reporte registrado exitosamente',
      folio,
      estatus: ESTATUS.RECIBIDO
    });

  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    res.status(500).json({ error: 'Error al crear reporte', detalle: error.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// Consulta ciudadana por folio. Devuelve solo campos públicos (RF-07, RF-08).
app.get('/api/v1/reportes/:folio', async (req, res) => {
  try {
    const { folio } = req.params;
    const [rows] = await pool.query(
      `SELECT r.folio, r.estatus, r.fecha_registro, r.fecha_ultima_atencion, m.nombre AS municipio
       FROM reporte r
       JOIN municipio m ON r.idMunicipio = m.idMunicipio
       WHERE r.folio = ?`,
      [folio]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'El folio consultado no existe' });
    }

    res.json({ reporte: rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar folio', detalle: error.message });
  }
});

// =========================================================================
// 2. EVIDENCIAS Y S3
// =========================================================================

app.post('/api/v1/evidencias/presigned-url', async (req, res) => {
  try {
    const { folio, nombreArchivo, fileType } = req.body;

    if (!folio || !nombreArchivo) {
      return res.status(400).json({ error: 'Se requiere folio y nombreArchivo' });
    }

    if (!BUCKET_NAME) {
      return res.status(500).json({ error: 'Falta la variable de entorno S3_BUCKET_NAME' });
    }

    // No se firma una URL de subida para un folio que no existe
    const [repRows] = await pool.query(
      'SELECT folio FROM reporte WHERE folio = ?',
      [folio]
    );

    if (repRows.length === 0) {
      return res.status(404).json({ error: 'El folio no existe' });
    }

    const key = `evidencias/${folio}/${Date.now()}_${nombreArchivo}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: fileType || 'image/jpeg'
    });

    // La URL firmada expira en 15 minutos (900 segundos)
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    res.json({ uploadUrl, key });
  } catch (error) {
    res.status(500).json({ error: 'Error al generar URL firmada', detalle: error.message });
  }
});

// Vincular la evidencia ya subida con el reporte. La purga es a los 10 días (RNF-32).
app.post('/api/v1/evidencias/confirmar', async (req, res) => {
  try {
    const { folio, key } = req.body;

    if (!folio || !key) {
      return res.status(400).json({ error: 'Se requiere folio y key' });
    }

    // La key la genera el servidor con el prefijo evidencias/{folio}/.
    // Si no coincide, se está intentando colgar un archivo ajeno al folio.
    const prefijoEsperado = `evidencias/${folio}/`;

    if (!key.startsWith(prefijoEsperado)) {
      return res.status(400).json({ error: 'La evidencia no corresponde al folio indicado' });
    }

    const [repRows] = await pool.query(
      'SELECT folio FROM reporte WHERE folio = ?',
      [folio]
    );

    if (repRows.length === 0) {
      return res.status(404).json({ error: 'El folio no existe' });
    }

    // Una misma key no se registra dos veces
    const [dup] = await pool.query(
      'SELECT idEvidencia FROM evidencia WHERE ruta_s3 = ?',
      [key]
    );

    if (dup.length > 0) {
      return res.status(409).json({
        error: 'Esa evidencia ya está registrada',
        idEvidencia: dup[0].idEvidencia
      });
    }

    const [result] = await pool.query(
      `INSERT INTO evidencia (folio, ruta_s3, fecha_carga, fecha_purga)
       VALUES (?, ?, CURRENT_TIMESTAMP, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 10 DAY))`,
      [folio, key]
    );

    res.status(201).json({
      message: 'Evidencia registrada exitosamente',
      idEvidencia: result.insertId
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar evidencia', detalle: error.message });
  }
});

// Generar una URL firmada de LECTURA para ver una evidencia.
// El bucket es privado, así que esta es la única forma de mostrar la imagen.
// Requiere sesión: las fotos son parte del expediente, no contenido público.
app.post('/api/v1/evidencias/url-lectura', verificarToken, async (req, res) => {
  try {
    const { key } = req.body;
    const { idRol, idMunicipio } = req.usuario;

    if (!key) {
      return res.status(400).json({ error: 'Se requiere key' });
    }

    if (!BUCKET_NAME) {
      return res.status(500).json({ error: 'Falta la variable de entorno S3_BUCKET_NAME' });
    }

    // La evidencia debe existir en la base, para no firmar rutas arbitrarias
    const [rows] = await pool.query(
      `SELECT e.idEvidencia, e.folio, e.fecha_purga, r.idMunicipio
       FROM evidencia e
       JOIN reporte r ON e.folio = r.folio
       WHERE e.ruta_s3 = ?`,
      [key]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'La evidencia no está registrada' });
    }

    const evidencia = rows[0];

    // Un Alimentador solo ve evidencias de su propio municipio
    if (idRol !== 1 && evidencia.idMunicipio !== idMunicipio) {
      return res.status(403).json({ error: 'No tiene jurisdicción sobre esta evidencia' });
    }

    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });

    // Cinco minutos: lo suficiente para desplegar la imagen, no para compartirla
    const urlLectura = await getSignedUrl(s3Client, command, { expiresIn: 300 });

    res.json({
      urlLectura: urlLectura,
      key: key,
      folio: evidencia.folio,
      expira_en_segundos: 300,
      fecha_purga: evidencia.fecha_purga
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al generar URL de lectura', detalle: error.message });
  }
});

// =========================================================================
// 3. AUTENTICACIÓN
// =========================================================================

app.post('/api/v1/auth/login', loginLimiter, async (req, res) => {
  try {
    const { correo_institucional, password } = req.body;

    if (!correo_institucional || !password) {
      return res.status(400).json({ error: 'Se requiere correo institucional y contraseña' });
    }

    const [rows] = await pool.query(
      `SELECT u.*, r.nombre AS nombre_rol, m.nombre AS nombre_municipio
       FROM usuario u
       JOIN rol r ON u.idRol = r.idRol
       JOIN municipio m ON u.idMunicipio = m.idMunicipio
       WHERE u.correo_institucional = ? AND u.activo = TRUE`,
      [correo_institucional]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const usuario = rows[0];

    // La contraseña nunca se compara en claro: se vuelve a calcular el hash
    // con el salt guardado y se comparan los hashes (RNF-31).
    const coincide = await bcrypt.compare(password, usuario.password_hash);

    if (!coincide) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    await pool.query(
      'UPDATE usuario SET ultimo_acceso = CURRENT_TIMESTAMP WHERE idUsuario = ?',
      [usuario.idUsuario]
    );

    const token = jwt.sign(
      {
        idUsuario: usuario.idUsuario,
        nombre: usuario.nombre,
        correo: usuario.correo_institucional,
        idRol: usuario.idRol,
        rol: usuario.nombre_rol,
        idMunicipio: usuario.idMunicipio,
        municipio: usuario.nombre_municipio
      },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    // El panel web usa esta cookie; JavaScript del navegador no puede leerla
    // porque es HttpOnly. El token sigue en el JSON para la app móvil.
    res.cookie('rieti_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000
    });

    res.json({
      message: 'Inicio de sesión exitoso',
      token,
      usuario: {
        idUsuario: usuario.idUsuario,
        nombre: usuario.nombre,
        rol: usuario.nombre_rol,
        municipio: usuario.nombre_municipio
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error en el servidor', detalle: error.message });
  }
});

app.get('/api/v1/auth/me', verificarToken, (req, res) => {
  res.json({ usuario: req.usuario });
});

// Cierre de sesión del panel web. No pide token: si la cookie ya venció
// igual hay que borrarla del navegador.
app.post('/api/v1/auth/logout', (req, res) => {
  res.clearCookie('rieti_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  });

  res.json({ message: 'Sesión cerrada correctamente' });
});

// Cambio de contraseña propia. Cualquier usuario con sesión puede hacerlo,
// pero debe comprobar que sabe la contraseña actual.
app.post('/api/v1/auth/password', verificarToken, async (req, res) => {
  try {
    const { idUsuario } = req.usuario;
    const { password_actual, password_nueva } = req.body;

    if (!password_actual || !password_nueva) {
      return res.status(400).json({ error: 'Se requiere password_actual y password_nueva' });
    }

    if (password_nueva.length < MIN_PASSWORD) {
      return res.status(400).json({
        error: 'La contraseña nueva debe tener al menos ' + MIN_PASSWORD + ' caracteres'
      });
    }

    if (password_actual === password_nueva) {
      return res.status(400).json({ error: 'La contraseña nueva debe ser distinta de la actual' });
    }

    const [rows] = await pool.query(
      'SELECT password_hash FROM usuario WHERE idUsuario = ? AND activo = TRUE',
      [idUsuario]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado o inactivo' });
    }

    const coincide = await bcrypt.compare(password_actual, rows[0].password_hash);

    if (!coincide) {
      return res.status(401).json({ error: 'La contraseña actual no es correcta' });
    }

    const nuevoHash = await bcrypt.hash(password_nueva, BCRYPT_ROUNDS);

    await pool.query(
      'UPDATE usuario SET password_hash = ? WHERE idUsuario = ?',
      [nuevoHash, idUsuario]
    );

    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar la contraseña', detalle: error.message });
  }
});

// =========================================================================
// 4. GESTIÓN DE USUARIOS (solo Administrador)
// =========================================================================

// Alta de una cuenta de funcionario (RF-11, RF-20)
app.post('/api/v1/admin/usuarios', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const { nombre, correo_institucional, telefono, password, idRol, idMunicipio } = req.body;

    if (!nombre || !correo_institucional || !password || !idRol || !idMunicipio) {
      return res.status(400).json({
        error: 'Se requiere nombre, correo_institucional, password, idRol e idMunicipio'
      });
    }

    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({
        error: 'La contraseña debe tener al menos ' + MIN_PASSWORD + ' caracteres'
      });
    }

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo_institucional)) {
      return res.status(400).json({ error: 'El correo institucional no tiene un formato válido' });
    }

    const [rolRows] = await pool.query('SELECT idRol FROM rol WHERE idRol = ?', [idRol]);
    if (rolRows.length === 0) {
      return res.status(400).json({ error: 'El rol indicado no existe' });
    }

    const [munRows] = await pool.query('SELECT idMunicipio FROM municipio WHERE idMunicipio = ?', [idMunicipio]);
    if (munRows.length === 0) {
      return res.status(400).json({ error: 'El municipio indicado no existe' });
    }

    const [dup] = await pool.query(
      'SELECT idUsuario FROM usuario WHERE correo_institucional = ?',
      [correo_institucional]
    );
    if (dup.length > 0) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo institucional' });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const [result] = await pool.query(
      `INSERT INTO usuario (nombre, correo_institucional, telefono, password_hash, idRol, idMunicipio, activo)
       VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
      [nombre, correo_institucional, telefono || null, hash, idRol, idMunicipio]
    );

    res.status(201).json({
      message: 'Usuario registrado exitosamente',
      idUsuario: result.insertId,
      correo_institucional: correo_institucional
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar usuario', detalle: error.message });
  }
});

// Consulta de usuarios, con filtro opcional por municipio.
// Nunca se devuelve el password_hash.
app.get('/api/v1/admin/usuarios', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const { idMunicipio, idRol, activo } = req.query;

    let sql = `
      SELECT u.idUsuario, u.nombre, u.correo_institucional, u.telefono,
             u.activo, u.ultimo_acceso,
             u.idRol, r.nombre AS rol,
             u.idMunicipio, m.nombre AS municipio, m.siglas
      FROM usuario u
      JOIN rol r ON u.idRol = r.idRol
      JOIN municipio m ON u.idMunicipio = m.idMunicipio
      WHERE 1=1
    `;
    const params = [];

    if (idMunicipio) {
      sql += ' AND u.idMunicipio = ?';
      params.push(idMunicipio);
    }

    if (idRol) {
      sql += ' AND u.idRol = ?';
      params.push(idRol);
    }

    if (activo === 'true' || activo === 'false') {
      sql += ' AND u.activo = ?';
      params.push(activo === 'true' ? 1 : 0);
    }

    sql += ' ORDER BY m.nombre ASC, u.nombre ASC';

    const [rows] = await pool.query(sql, params);
    res.json({ total: rows.length, usuarios: rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar usuarios', detalle: error.message });
  }
});

// Editar los datos de un funcionario. Solo se tocan los campos que se manden.
// El correo y la contraseña no se cambian por aquí.
app.patch('/api/v1/admin/usuarios/:id', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { nombre, telefono, idRol, idMunicipio } = req.body;

    if (isNaN(id)) {
      return res.status(400).json({ error: 'El id del usuario no es válido' });
    }

    const [existe] = await pool.query('SELECT idUsuario FROM usuario WHERE idUsuario = ?', [id]);
    if (existe.length === 0) {
      return res.status(404).json({ error: 'El usuario no existe' });
    }

    const campos = [];
    const params = [];

    if (nombre !== undefined) {
      if (!nombre.trim()) {
        return res.status(400).json({ error: 'El nombre no puede quedar vacío' });
      }
      campos.push('nombre = ?');
      params.push(nombre.trim());
    }

    if (telefono !== undefined) {
      campos.push('telefono = ?');
      params.push(telefono || null);
    }

    if (idRol !== undefined) {
      const [rolRows] = await pool.query('SELECT idRol FROM rol WHERE idRol = ?', [idRol]);
      if (rolRows.length === 0) {
        return res.status(400).json({ error: 'El rol indicado no existe' });
      }
      campos.push('idRol = ?');
      params.push(idRol);
    }

    if (idMunicipio !== undefined) {
      const [munRows] = await pool.query('SELECT idMunicipio FROM municipio WHERE idMunicipio = ?', [idMunicipio]);
      if (munRows.length === 0) {
        return res.status(400).json({ error: 'El municipio indicado no existe' });
      }
      campos.push('idMunicipio = ?');
      params.push(idMunicipio);
    }

    if (campos.length === 0) {
      return res.status(400).json({
        error: 'No se mandó ningún campo que modificar',
        editables: ['nombre', 'telefono', 'idRol', 'idMunicipio']
      });
    }

    params.push(id);
    await pool.query('UPDATE usuario SET ' + campos.join(', ') + ' WHERE idUsuario = ?', params);

    const [rows] = await pool.query(
      `SELECT u.idUsuario, u.nombre, u.correo_institucional, u.telefono, u.activo,
              u.idRol, r.nombre AS rol, u.idMunicipio, m.nombre AS municipio
       FROM usuario u
       JOIN rol r ON u.idRol = r.idRol
       JOIN municipio m ON u.idMunicipio = m.idMunicipio
       WHERE u.idUsuario = ?`,
      [id]
    );

    res.json({ message: 'Usuario actualizado correctamente', usuario: rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar usuario', detalle: error.message });
  }
});

// Baja y alta lógica de una cuenta. No se borra el renglón porque bitacora,
// historial_estatus y transferencia guardan referencias al funcionario.
app.patch('/api/v1/admin/usuarios/:id/estado', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { activo } = req.body;

    if (isNaN(id)) {
      return res.status(400).json({ error: 'El id del usuario no es válido' });
    }

    if (typeof activo !== 'boolean') {
      return res.status(400).json({ error: 'Se requiere activo con valor true o false' });
    }

    const [rows] = await pool.query(
      'SELECT idUsuario, nombre, idRol, activo FROM usuario WHERE idUsuario = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'El usuario no existe' });
    }

    const usuario = rows[0];

    if (!!usuario.activo === activo) {
      return res.status(400).json({
        error: 'La cuenta ya se encuentra ' + (activo ? 'activa' : 'inactiva')
      });
    }

    // Protecciones para no dejar el sistema sin quien administre
    if (!activo) {
      if (id === req.usuario.idUsuario) {
        return res.status(400).json({ error: 'No puede desactivar su propia cuenta' });
      }

      if (usuario.idRol === 1) {
        const [admins] = await pool.query(
          'SELECT COUNT(*) AS total FROM usuario WHERE idRol = 1 AND activo = TRUE'
        );
        if (admins[0].total <= 1) {
          return res.status(400).json({
            error: 'No se puede desactivar al único Administrador activo del sistema'
          });
        }
      }
    }

    await pool.query('UPDATE usuario SET activo = ? WHERE idUsuario = ?', [activo ? 1 : 0, id]);

    res.json({
      message: 'Cuenta ' + (activo ? 'activada' : 'desactivada') + ' correctamente',
      idUsuario: id,
      nombre: usuario.nombre,
      activo: activo
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar el estado de la cuenta', detalle: error.message });
  }
});

// =========================================================================
// 5. RUTAS ADMINISTRATIVAS
// =========================================================================

// Bandeja de reportes. El Alimentador solo ve su municipio (RF-12).
app.get('/api/v1/admin/reportes', verificarToken, async (req, res) => {
  try {
    const { idRol, idMunicipio } = req.usuario;
    const { estatus, prioridad } = req.query;

    let sql = `
      SELECT r.folio, r.modalidad, r.num_menores, r.descripcion, r.estatus, r.prioridad,
             r.fecha_registro, r.latitud, r.longitud,
             m.nombre AS municipio, c.nombre AS actividad
      FROM reporte r
      JOIN municipio m ON r.idMunicipio = m.idMunicipio
      JOIN catalogo_actividad c ON r.idCatalogoActividad = c.idCatalogoActividad
      WHERE 1=1
    `;
    const params = [];

    if (idRol !== 1) {
      sql += ' AND r.idMunicipio = ?';
      params.push(idMunicipio);
    }

    if (estatus) {
      sql += ' AND r.estatus = ?';
      params.push(estatus);
    }

    if (prioridad) {
      sql += ' AND r.prioridad = ?';
      params.push(prioridad);
    }

    sql += ' ORDER BY r.fecha_registro DESC';

    const [rows] = await pool.query(sql, params);
    res.json({ reportes: rows });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener bandeja', detalle: error.message });
  }
});

app.get('/api/v1/admin/reportes/:folio/expediente', verificarToken, async (req, res) => {
  try {
    const { folio } = req.params;
    const { idRol, idMunicipio } = req.usuario;

    const [repRows] = await pool.query(
      `SELECT r.*, m.nombre AS nombre_municipio, c.nombre AS nombre_actividad
       FROM reporte r
       JOIN municipio m ON r.idMunicipio = m.idMunicipio
       JOIN catalogo_actividad c ON r.idCatalogoActividad = c.idCatalogoActividad
       WHERE r.folio = ?`,
      [folio]
    );

    if (repRows.length === 0) {
      return res.status(404).json({ error: 'Expediente no encontrado' });
    }

    // Un Alimentador no puede abrir expedientes de otro municipio
    if (idRol !== 1 && repRows[0].idMunicipio !== idMunicipio) {
      return res.status(403).json({ error: 'No tiene jurisdicción sobre este expediente' });
    }

    const [evidencias] = await pool.query('SELECT * FROM evidencia WHERE folio = ?', [folio]);
    const [bitacora] = await pool.query('SELECT * FROM bitacora WHERE folio = ? ORDER BY fecha DESC', [folio]);
    const [historial] = await pool.query('SELECT * FROM historial_estatus WHERE folio = ? ORDER BY fecha DESC', [folio]);

    res.json({ expediente: repRows[0], evidencias, bitacora, historial });
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar expediente', detalle: error.message });
  }
});

// Asignar un reporte al funcionario que lo va a atender (RF-16)
app.post('/api/v1/admin/asignaciones', verificarToken, soloAdministrador, async (req, res) => {
  try {
    const { folio, idUsuario } = req.body;

    if (!folio || !idUsuario) {
      return res.status(400).json({ error: 'Se requiere folio e idUsuario' });
    }

    const [repRows] = await pool.query(
      'SELECT folio, idMunicipio, estatus FROM reporte WHERE folio = ?',
      [folio]
    );
    if (repRows.length === 0) {
      return res.status(404).json({ error: 'El reporte no existe' });
    }

    const [usrRows] = await pool.query(
      `SELECT u.idUsuario, u.nombre, u.activo, u.idMunicipio, m.nombre AS municipio
       FROM usuario u
       JOIN municipio m ON u.idMunicipio = m.idMunicipio
       WHERE u.idUsuario = ?`,
      [idUsuario]
    );
    if (usrRows.length === 0) {
      return res.status(404).json({ error: 'El funcionario no existe' });
    }

    const funcionario = usrRows[0];

    if (!funcionario.activo) {
      return res.status(400).json({ error: 'El funcionario está dado de baja' });
    }

    // Nadie puede atender un reporte de un municipio que no es el suyo
    if (funcionario.idMunicipio !== repRows[0].idMunicipio) {
      return res.status(400).json({
        error: 'El funcionario no pertenece al municipio del reporte',
        municipio_funcionario: funcionario.municipio
      });
    }

    const [yaAsignado] = await pool.query(
      'SELECT idUsuario FROM asignacion WHERE folio = ?',
      [folio]
    );
    if (yaAsignado.length > 0) {
      return res.status(409).json({
        error: 'El reporte ya está asignado',
        idUsuario_actual: yaAsignado[0].idUsuario
      });
    }

    const [result] = await pool.query(
      'INSERT INTO asignacion (folio, idUsuario, fecha_asignacion) VALUES (?, ?, CURRENT_TIMESTAMP)',
      [folio, idUsuario]
    );

    res.status(201).json({
      message: 'Reporte asignado correctamente',
      idAsignacion: result.insertId,
      folio: folio,
      idUsuario: idUsuario,
      nombre: funcionario.nombre
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al asignar el reporte', detalle: error.message });
  }
});

// Registrar una actuación en bitácora y, opcionalmente, cambiar el estatus
app.post('/api/v1/admin/atencion', verificarToken, async (req, res) => {
  let connection;
  try {
    const { idUsuario, idRol, idMunicipio } = req.usuario;
    const { folio, accion, nota_interna, nuevo_estatus, justificacion } = req.body;

    if (!folio || !accion) {
      return res.status(400).json({ error: 'Se requiere folio y accion' });
    }

    // El cambio de estatus siempre lleva justificación (RF-18)
    if (nuevo_estatus && !justificacion) {
      return res.status(400).json({ error: 'Todo cambio de estatus requiere justificación' });
    }

    if (nuevo_estatus && !Object.values(ESTATUS).includes(nuevo_estatus)) {
      return res.status(400).json({
        error: 'Estatus no válido',
        validos: Object.values(ESTATUS)
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // El reporte se consulta antes de escribir nada, para comprobar que existe
    // y que el funcionario tiene jurisdicción sobre él
    const [repRows] = await connection.query(
      'SELECT idMunicipio, estatus FROM reporte WHERE folio = ?',
      [folio]
    );

    if (repRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'El folio no existe' });
    }

    // Un Alimentador solo puede atender reportes de su municipio
    if (idRol !== 1 && repRows[0].idMunicipio !== idMunicipio) {
      await connection.rollback();
      return res.status(403).json({ error: 'No tiene jurisdicción sobre este reporte' });
    }

    await connection.query(
      'INSERT INTO bitacora (folio, idUsuario, accion, nota_interna) VALUES (?, ?, ?, ?)',
      [folio, idUsuario, accion, nota_interna || '']
    );

    if (nuevo_estatus) {
      const estatusAnterior = repRows[0].estatus;

      await connection.query(
        'UPDATE reporte SET estatus = ?, fecha_ultima_atencion = CURRENT_TIMESTAMP WHERE folio = ?',
        [nuevo_estatus, folio]
      );

      await connection.query(
        `INSERT INTO historial_estatus (folio, estatus_anterior, estatus_nuevo, idUsuario, justificacion)
         VALUES (?, ?, ?, ?, ?)`,
        [folio, estatusAnterior, nuevo_estatus, idUsuario, justificacion]
      );
    } else {
      await connection.query(
        'UPDATE reporte SET fecha_ultima_atencion = CURRENT_TIMESTAMP WHERE folio = ?',
        [folio]
      );
    }

    await connection.commit();
    res.json({ message: 'Atención registrada correctamente' });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    res.status(500).json({ error: 'Error al registrar atención', detalle: error.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// Transferencia intermunicipal (RF-21), canalización a PPNNA (RF-22) y descarte
app.post('/api/v1/admin/transferencias', verificarToken, soloAdministrador, async (req, res) => {
  let connection;
  try {
    const { idUsuario } = req.usuario;
    const { tipo, folio, idMunicipioDestino, numero_oficio, motivo, justificacion } = req.body;

    if (!tipo || !folio) {
      return res.status(400).json({ error: 'Se requiere tipo y folio' });
    }

    if (!justificacion) {
      return res.status(400).json({ error: 'Se requiere justificación' });
    }

    const TIPOS_VALIDOS = ['TRANSFERENCIA_MUNICIPIO', 'CANALIZACION_PPNNA', 'DESCARTE'];
    if (!TIPOS_VALIDOS.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo no válido', validos: TIPOS_VALIDOS });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [currRep] = await connection.query(
      'SELECT idMunicipio, estatus FROM reporte WHERE folio = ?',
      [folio]
    );

    if (currRep.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'El folio no existe' });
    }

    const estatusAnterior = currRep[0].estatus;
    let nuevoEstatus = estatusAnterior;

    if (tipo === 'TRANSFERENCIA_MUNICIPIO') {
      if (!idMunicipioDestino) {
        await connection.rollback();
        return res.status(400).json({ error: 'Se requiere idMunicipioDestino' });
      }

      const idOrigen = currRep[0].idMunicipio;

      if (idOrigen === idMunicipioDestino) {
        await connection.rollback();
        return res.status(400).json({ error: 'El municipio destino debe ser distinto al de origen' });
      }

      await connection.query(
        `INSERT INTO transferencia (folio, idMunicipioOrigen, idMunicipioDestino, idUsuario, justificacion)
         VALUES (?, ?, ?, ?, ?)`,
        [folio, idOrigen, idMunicipioDestino, idUsuario, justificacion]
      );

      await connection.query(
        'UPDATE reporte SET idMunicipio = ?, fecha_ultima_atencion = CURRENT_TIMESTAMP WHERE folio = ?',
        [idMunicipioDestino, folio]
      );

    } else if (tipo === 'CANALIZACION_PPNNA') {
      if (!numero_oficio) {
        await connection.rollback();
        return res.status(400).json({ error: 'Se requiere numero_oficio' });
      }

      await connection.query(
        'INSERT INTO canalizacion_estatal (folio, numero_oficio, idUsuario) VALUES (?, ?, ?)',
        [folio, numero_oficio, idUsuario]
      );

      nuevoEstatus = ESTATUS.CANALIZADO;

    } else if (tipo === 'DESCARTE') {
      if (!motivo) {
        await connection.rollback();
        return res.status(400).json({ error: 'Se requiere motivo' });
      }

      await connection.query(
        'INSERT INTO descarte (folio, motivo, justificacion, idUsuario) VALUES (?, ?, ?, ?)',
        [folio, motivo, justificacion, idUsuario]
      );

      nuevoEstatus = ESTATUS.CANCELADO;

    } else {
      await connection.rollback();
      return res.status(400).json({
        error: 'Tipo no válido',
        validos: ['TRANSFERENCIA_MUNICIPIO', 'CANALIZACION_PPNNA', 'DESCARTE']
      });
    }

    // Cualquier cambio de estatus queda asentado en el historial
    if (nuevoEstatus !== estatusAnterior) {
      await connection.query(
        'UPDATE reporte SET estatus = ?, fecha_ultima_atencion = CURRENT_TIMESTAMP WHERE folio = ?',
        [nuevoEstatus, folio]
      );

      await connection.query(
        `INSERT INTO historial_estatus (folio, estatus_anterior, estatus_nuevo, idUsuario, justificacion)
         VALUES (?, ?, ?, ?, ?)`,
        [folio, estatusAnterior, nuevoEstatus, idUsuario, justificacion]
      );
    }

    await connection.commit();
    res.json({ message: `Movimiento de tipo ${tipo} procesado exitosamente` });
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    res.status(500).json({ error: 'Error al procesar transferencia', detalle: error.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// =========================================================================
// 6. DASHBOARD
// =========================================================================

// Números para las tarjetas del panel. Se cuentan en la base, no en el cliente.
// Un Alimentador solo ve los de su municipio.
app.get('/api/v1/admin/dashboard/resumen', verificarToken, async (req, res) => {
  try {
    const { idRol, idMunicipio } = req.usuario;

    let filtro = '';
    const params = [];

    if (idRol !== 1) {
      filtro = ' WHERE idMunicipio = ?';
      params.push(idMunicipio);
    }

    const [rows] = await pool.query(
      'SELECT estatus, COUNT(*) AS total FROM reporte' + filtro + ' GROUP BY estatus',
      params
    );

    // Las llaves salen siempre, aunque ese estatus no tenga reportes,
    // para que el frontend no tenga que validar si existen.
    const resumen = {
      total: 0,
      recibidos: 0,
      en_revision: 0,
      en_proceso: 0,
      concluidos: 0,
      reincidencias: 0,
      canalizados: 0,
      cancelados: 0
    };

    const llave = {
      'Recibido': 'recibidos',
      'En Revision': 'en_revision',
      'En Proceso': 'en_proceso',
      'Concluido': 'concluidos',
      'Reincidencia': 'reincidencias',
      'Canalizado': 'canalizados',
      'Cancelado': 'cancelados'
    };

    rows.forEach(function (r) {
      const total = Number(r.total);
      resumen.total += total;
      if (llave[r.estatus]) resumen[llave[r.estatus]] = total;
    });

    res.json(resumen);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener el resumen', detalle: error.message });
  }
});

// Datos agrupados para las gráficas del panel.
app.get('/api/v1/admin/dashboard/estadisticas', verificarToken, async (req, res) => {
  try {
    const { idRol, idMunicipio } = req.usuario;
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 30, 1), 365);

    let filtro = '';
    const params = [];

    if (idRol !== 1) {
      filtro = ' WHERE r.idMunicipio = ?';
      params.push(idMunicipio);
    }

    const [por_estatus] = await pool.query(
      'SELECT r.estatus, COUNT(*) AS total FROM reporte r' + filtro +
      ' GROUP BY r.estatus ORDER BY total DESC',
      params
    );

    const [por_municipio] = await pool.query(
      'SELECT m.nombre AS municipio, m.siglas, COUNT(*) AS total' +
      ' FROM reporte r JOIN municipio m ON r.idMunicipio = m.idMunicipio' + filtro +
      ' GROUP BY m.idMunicipio, m.nombre, m.siglas ORDER BY total DESC',
      params
    );

    const [por_actividad] = await pool.query(
      'SELECT c.nombre AS actividad, COUNT(*) AS total' +
      ' FROM reporte r JOIN catalogo_actividad c ON r.idCatalogoActividad = c.idCatalogoActividad' + filtro +
      ' GROUP BY c.idCatalogoActividad, c.nombre ORDER BY total DESC',
      params
    );

    const [por_prioridad] = await pool.query(
      'SELECT r.prioridad, COUNT(*) AS total FROM reporte r' + filtro +
      ' GROUP BY r.prioridad ORDER BY total DESC',
      params
    );

    const filtroFecha = filtro
      ? filtro + ' AND r.fecha_registro >= DATE_SUB(CURRENT_DATE, INTERVAL ? DAY)'
      : ' WHERE r.fecha_registro >= DATE_SUB(CURRENT_DATE, INTERVAL ? DAY)';

    const [por_fecha] = await pool.query(
      'SELECT DATE(r.fecha_registro) AS fecha, COUNT(*) AS total FROM reporte r' + filtroFecha +
      ' GROUP BY DATE(r.fecha_registro) ORDER BY fecha ASC',
      params.concat([dias])
    );

    res.json({
      dias_considerados: dias,
      por_estatus: por_estatus,
      por_municipio: por_municipio,
      por_actividad: por_actividad,
      por_prioridad: por_prioridad,
      por_fecha: por_fecha
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener las estadísticas', detalle: error.message });
  }
});

// Cualquier ruta no encontrada responde JSON, no el HTML de Express
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada', ruta_recibida: req.originalUrl });
});

export default app;
export { pool };