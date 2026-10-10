// app.mjs
// Toda la lógica del backend RIETI vive aquí.
// lambda.mjs la envuelve para AWS Lambda y server.mjs la levanta en local,
// así las dos versiones nunca se desincronizan.

import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const app = express();

app.use(cors());
app.use(express.json());

// Si la API se expone por API Gateway, el path llega con el stage y el recurso
// al inicio (/default/rieti-backend/api/v1/...). Con Function URL y en local
// llega limpio. Este middleware recorta el prefijo solo cuando existe.
/**
 * Normaliza la ruta recibida cuando la API se ejecuta detrás de API Gateway.
 * Conserva sin cambios las rutas recibidas mediante Function URL o ejecución local.
 *
 * @param {import('express').Request} req Solicitud HTTP entrante.
 * @param {import('express').Response} res Respuesta HTTP.
 * @param {import('express').NextFunction} next Función para continuar con el siguiente middleware.
 */
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

const JWT_SECRET = process.env.JWT_SECRET || 'secreto_rieti_local';

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

// =========================================================================
// MIDDLEWARE DE AUTENTICACIÓN (JWT)
// =========================================================================

/**
 * Verifica el token JWT enviado mediante el encabezado Authorization.
 * Si el token es válido, almacena la información del usuario en req.usuario.
 *
 * @param {import('express').Request} req Solicitud HTTP.
 * @param {import('express').Response} res Respuesta HTTP.
 * @param {import('express').NextFunction} next Función para continuar con la solicitud.
 * @returns {void}
 */
const verificarToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Acceso denegado. Token no proporcionado.' });
  }

  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Token inválido o expirado.' });
  }
};

// Solo el rol Administrador (idRol 1) puede ejecutar la acción
/**
 * Restringe el acceso a usuarios con rol Administrador.
 * Debe ejecutarse después de verificarToken.
 *
 * @param {import('express').Request} req Solicitud HTTP con req.usuario disponible.
 * @param {import('express').Response} res Respuesta HTTP.
 * @param {import('express').NextFunction} next Función para continuar con la solicitud.
 * @returns {void}
 */
const soloAdministrador = (req, res, next) => {
  if (req.usuario.idRol !== 1) {
    return res.status(403).json({ error: 'Esta acción requiere perfil de Administrador' });
  }
  next();
};

// =========================================================================
// HEALTHCHECK
// =========================================================================

/**
 * Comprueba que el backend se encuentra disponible y que las variables
 * principales de configuración están definidas.
 *
 * @route GET /health
 */
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

/**
 * Obtiene el catálogo de actividades registrado en la base de datos.
 *
 * @route GET /api/v1/catalogos/actividades
 * @returns {Promise<void>}
 */
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

/**
 * Obtiene el catálogo de municipios disponibles en RIETI.
 *
 * @route GET /api/v1/municipios
 * @returns {Promise<void>}
 */
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
/**
 * Registra un nuevo reporte ciudadano.
 * Valida los datos recibidos, genera un folio consecutivo por municipio,
 * calcula una huella SHA-256 y almacena el reporte mediante una transacción.
 *
 * @route POST /api/v1/reportes
 * @returns {Promise<void>}
 */
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
/**
 * Consulta el estado público de un reporte utilizando su folio.
 * La respuesta excluye información interna del expediente.
 *
 * @route GET /api/v1/reportes/:folio
 * @returns {Promise<void>}
 */
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

/**
 * Genera una URL prefirmada temporal para subir una evidencia a Amazon S3.
 *
 * @route POST /api/v1/evidencias/presigned-url
 * @returns {Promise<void>}
 */
app.post('/api/v1/evidencias/presigned-url', async (req, res) => {
  try {
    const { folio, nombreArchivo, fileType } = req.body;

    if (!folio || !nombreArchivo) {
      return res.status(400).json({ error: 'Se requiere folio y nombreArchivo' });
    }

    if (!BUCKET_NAME) {
      return res.status(500).json({ error: 'Falta la variable de entorno S3_BUCKET_NAME' });
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
/**
 * Registra en la base de datos una evidencia previamente subida a Amazon S3.
 *
 * @route POST /api/v1/evidencias/confirmar
 * @returns {Promise<void>}
 */
app.post('/api/v1/evidencias/confirmar', async (req, res) => {
  try {
    const { folio, key } = req.body;

    if (!folio || !key) {
      return res.status(400).json({ error: 'Se requiere folio y key' });
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
/**
 * Genera una URL temporal de lectura para una evidencia privada almacenada en S3.
 * Verifica que la evidencia esté registrada y que el usuario tenga jurisdicción.
 *
 * @route POST /api/v1/evidencias/url-lectura
 * @returns {Promise<void>}
 */
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

/**
 * Autentica a un usuario institucional mediante correo y contraseña.
 * Si las credenciales son válidas, genera un JWT con vigencia limitada.
 *
 * @route POST /api/v1/auth/login
 * @returns {Promise<void>}
 */
app.post('/api/v1/auth/login', async (req, res) => {
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

/**
 * Devuelve la información contenida en el token de la sesión actual.
 *
 * @route GET /api/v1/auth/me
 */
app.get('/api/v1/auth/me', verificarToken, (req, res) => {
  res.json({ usuario: req.usuario });
});

// Cambio de contraseña propia. Cualquier usuario con sesión puede hacerlo,
// pero debe comprobar que sabe la contraseña actual.
/**
 * Permite a un usuario autenticado cambiar su propia contraseña.
 * Valida la contraseña actual antes de almacenar el nuevo hash.
 *
 * @route POST /api/v1/auth/password
 * @returns {Promise<void>}
 */
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
/**
 * Registra una nueva cuenta institucional.
 * Esta operación está restringida al rol Administrador.
 *
 * @route POST /api/v1/admin/usuarios
 * @returns {Promise<void>}
 */
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
/**
 * Obtiene la lista de usuarios institucionales con filtros opcionales.
 * Nunca devuelve el hash de las contraseñas.
 *
 * @route GET /api/v1/admin/usuarios
 * @returns {Promise<void>}
 */
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
/**
 * Modifica datos editables de una cuenta institucional existente.
 *
 * @route PATCH /api/v1/admin/usuarios/:id
 * @returns {Promise<void>}
 */
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
/**
 * Activa o desactiva lógicamente una cuenta institucional.
 * Incluye validaciones para evitar desactivar la propia cuenta o al único administrador.
 *
 * @route PATCH /api/v1/admin/usuarios/:id/estado
 * @returns {Promise<void>}
 */
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
/**
 * Obtiene la bandeja administrativa de reportes.
 * Los usuarios no administradores quedan limitados a su municipio.
 *
 * @route GET /api/v1/admin/reportes
 * @returns {Promise<void>}
 */
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

/**
 * Obtiene el expediente completo de un reporte, incluyendo evidencias,
 * bitácora e historial de estatus.
 *
 * @route GET /api/v1/admin/reportes/:folio/expediente
 * @returns {Promise<void>}
 */
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
/**
 * Asigna un reporte a un funcionario activo del mismo municipio.
 *
 * @route POST /api/v1/admin/asignaciones
 * @returns {Promise<void>}
 */
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
/**
 * Registra una actuación en la bitácora y permite actualizar opcionalmente
 * el estatus del reporte dentro de una transacción.
 *
 * @route POST /api/v1/admin/atencion
 * @returns {Promise<void>}
 */
app.post('/api/v1/admin/atencion', verificarToken, async (req, res) => {
  let connection;
  try {
    const { idUsuario } = req.usuario;
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

    await connection.query(
      'INSERT INTO bitacora (folio, idUsuario, accion, nota_interna) VALUES (?, ?, ?, ?)',
      [folio, idUsuario, accion, nota_interna || '']
    );

    if (nuevo_estatus) {
      const [currRep] = await connection.query('SELECT estatus FROM reporte WHERE folio = ?', [folio]);

      if (currRep.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: 'El folio no existe' });
      }

      const estatusAnterior = currRep[0].estatus;

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
/**
 * Procesa transferencias intermunicipales, canalizaciones a PPNNA
 * y descartes administrativos.
 *
 * @route POST /api/v1/admin/transferencias
 * @returns {Promise<void>}
 */
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
/**
 * Obtiene los totales de reportes agrupados por estatus para el dashboard.
 * Los Alimentadores solo reciben información correspondiente a su municipio.
 *
 * @route GET /api/v1/admin/dashboard/resumen
 * @returns {Promise<void>}
 */
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
/**
 * Obtiene estadísticas agrupadas por estatus, municipio, actividad,
 * prioridad y fecha para las gráficas del dashboard.
 *
 * @route GET /api/v1/admin/dashboard/estadisticas
 * @returns {Promise<void>}
 */
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
