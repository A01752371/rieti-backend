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
      'SELECT idMunicipio, nombre, siglas, clave_inegi FROM municipio WHERE adherido_rieti = TRUE ORDER BY nombre ASC'
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar municipios', detalle: error.message });
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

    // Campos obligatorios confirmados con el socio formador:
    // correo de contacto, ubicación y aceptación del aviso de privacidad.
    if (!correo_contacto) {
      return res.status(400).json({ error: 'El correo electrónico de contacto es obligatorio' });
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

    const modalidadFinal = modalidad || 'SEGUIMIENTO';
    const horaFinal = hora_observada || new Date().toTimeString().slice(0, 8);

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
        correo_contacto,
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

app.get('/api/v1/auth/me', verificarToken, (req, res) => {
  res.json({ usuario: req.usuario });
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

// Registrar una actuación en bitácora y, opcionalmente, cambiar el estatus
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

// Cualquier ruta no encontrada responde JSON, no el HTML de Express
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada', ruta_recibida: req.originalUrl });
});

export default app;
export { pool };
