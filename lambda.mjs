// lambda.mjs
import serverlessExpress from '@codegenie/serverless-express';
import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'secreto_rieti';

app.use(cors());
app.use(express.json());

// Pool de conexiones a MySQL (usando variables de entorno de Lambda)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 5,
  ssl: {
    rejectUnauthorized: false
  }
});

// Middleware JWT
const verificarToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token no proporcionado' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.usuario = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Token inválido' });
  }
};

// --- RUTAS PÚBLICAS ---
app.get('/api/v1/catalogos/actividades', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT idCatalogoActividad, nombre FROM catalogo_actividad ORDER BY nombre ASC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/municipios', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT idMunicipio, nombre, clave_inegi FROM municipio WHERE adherido_rieti = TRUE ORDER BY nombre ASC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/reportes', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const {
      modalidad, correo_contacto, num_menores, rango_edad, genero_observado,
      idCatalogoActividad, hora_observada, descripcion, situacion_riesgo,
      latitud, longitud, calle, colonia, cp, referencias, idMunicipio, acepto_aviso
    } = req.body;

    await connection.query('UPDATE municipio SET contador = contador + 1 WHERE idMunicipio = ?', [idMunicipio]);
    const [munRows] = await connection.query('SELECT clave_inegi, contador FROM municipio WHERE idMunicipio = ?', [idMunicipio]);
    
    const municipio = munRows[0];
    const anioActual = new Date().getFullYear();
    const consecutivo = String(municipio.contador).padStart(5, '0');
    const folio = `RIETI-${municipio.clave_inegi}-${anioActual}-${consecutivo}`;

    const payloadIntegridad = `${folio}|${latitud}|${longitud}|${idCatalogoActividad}|${descripcion}`;
    const hash_sha256 = crypto.createHash('sha256').update(payloadIntegridad).digest('hex');

    await connection.query(
      `INSERT INTO reporte (
        folio, modalidad, correo_contacto, num_menores, rango_edad, genero_observado,
        idCatalogoActividad, hora_observada, descripcion, situacion_riesgo, latitud, longitud,
        calle, colonia, cp, referencias, idMunicipio, estatus, prioridad, hash_sha256, acepto_aviso, fecha_aceptacion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Recibido', 'Media', ?, ?, CURRENT_TIMESTAMP)`,
      [
        folio, modalidad, correo_contacto || null, num_menores, rango_edad || 'No especificado', genero_observado || 'No especificado',
        idCatalogoActividad, hora_observada || '12:00:00', descripcion, situacion_riesgo ? 1 : 0, latitud || 0.0, longitud || 0.0,
        calle || 'Sin calle', colonia || 'Sin colonia', cp || null, referencias || null, idMunicipio, hash_sha256, acepto_aviso ? 1 : 0
      ]
    );

    await connection.commit();
    res.status(201).json({ message: 'Reporte registrado exitosamente', folio, estatus: 'Recibido' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

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
    if (rows.length === 0) return res.status(404).json({ error: 'El folio no existe' });
    res.json({ reporte: rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/evidencias/presigned-url', (req, res) => {
  const { folio, nombreArchivo } = req.body;
  res.json({
    uploadUrl: `https://rieti-bucket.s3.amazonaws.com/${folio}_${nombreArchivo}`,
    key: `${folio}_${nombreArchivo}`
  });
});

// --- AUTENTICACIÓN ---
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { correo_institucional, password } = req.body;
    const [rows] = await pool.query(
      `SELECT u.*, r.nombre AS nombre_rol, m.nombre AS nombre_municipio 
       FROM usuario u
       JOIN rol r ON u.idRol = r.idRol
       JOIN municipio m ON u.idMunicipio = m.idMunicipio
       WHERE u.correo_institucional = ? AND u.activo = TRUE`,
      [correo_institucional]
    );

    if (rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });

    const usuario = rows[0];
    if (password !== usuario.password_hash) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    await pool.query('UPDATE usuario SET ultimo_acceso = CURRENT_TIMESTAMP WHERE idUsuario = ?', [usuario.idUsuario]);

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
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/auth/me', verificarToken, (req, res) => {
  res.json({ usuario: req.usuario });
});

// --- RUTAS ADMINISTRATIVAS ---
app.get('/api/v1/admin/reportes', verificarToken, async (req, res) => {
  try {
    const { idRol, idMunicipio } = req.usuario;
    let sql = `
      SELECT r.folio, r.modalidad, r.num_menores, r.descripcion, r.estatus, r.prioridad, 
             r.fecha_registro, m.nombre AS municipio, c.nombre AS actividad
      FROM reporte r
      JOIN municipio m ON r.idMunicipio = m.idMunicipio
      JOIN catalogo_actividad c ON r.idCatalogoActividad = c.idCatalogoActividad
      WHERE 1=1
    `;
    const params = [];

    if (idRol === 2) {
      sql += ' AND r.idMunicipio = ?';
      params.push(idMunicipio);
    }

    sql += ' ORDER BY r.fecha_registro DESC';
    const [rows] = await pool.query(sql, params);
    res.json({ reportes: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/admin/reportes/:folio/expediente', verificarToken, async (req, res) => {
  try {
    const { folio } = req.params;
    const [repRows] = await pool.query(
      `SELECT r.*, m.nombre AS nombre_municipio, c.nombre AS nombre_actividad
       FROM reporte r
       JOIN municipio m ON r.idMunicipio = m.idMunicipio
       JOIN catalogo_actividad c ON r.idCatalogoActividad = c.idCatalogoActividad
       WHERE r.folio = ?`,
      [folio]
    );

    if (repRows.length === 0) return res.status(404).json({ error: 'Expediente no encontrado' });

    const [evidencias] = await pool.query('SELECT * FROM evidencia WHERE folio = ?', [folio]);
    const [bitacora] = await pool.query('SELECT * FROM bitacora WHERE folio = ? ORDER BY fecha DESC', [folio]);
    const [historial] = await pool.query('SELECT * FROM historial_estatus WHERE folio = ? ORDER BY fecha DESC', [folio]);

    res.json({ expediente: repRows[0], evidencias, bitacora, historial });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/admin/atencion', verificarToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { idUsuario } = req.usuario;
    const { folio, accion, nota_interna, nuevo_estatus, justificacion } = req.body;

    await connection.query(
      'INSERT INTO bitacora (folio, idUsuario, accion, nota_interna) VALUES (?, ?, ?, ?)',
      [folio, idUsuario, accion, nota_interna || '']
    );

    if (nuevo_estatus) {
      const [currRep] = await connection.query('SELECT estatus FROM reporte WHERE folio = ?', [folio]);
      const estatusAnterior = currRep[0]?.estatus || 'Recibido';

      await connection.query('UPDATE reporte SET estatus = ? WHERE folio = ?', [nuevo_estatus, folio]);
      await connection.query(
        'INSERT INTO historial_estatus (folio, estatus_anterior, estatus_nuevo, idUsuario, justificacion) VALUES (?, ?, ?, ?, ?)',
        [folio, estatusAnterior, nuevo_estatus, idUsuario, justificacion || 'Sin justificación']
      );
    }

    await connection.commit();
    res.json({ message: 'Atención registrada correctamente' });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

app.post('/api/v1/admin/transferencias', verificarToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const { idUsuario } = req.usuario;
    const { tipo, folio, idMunicipioDestino, numero_oficio, motivo, justificacion } = req.body;

    if (tipo === 'TRANSFERENCIA_MUNICIPIO') {
      const [currRep] = await connection.query('SELECT idMunicipio FROM reporte WHERE folio = ?', [folio]);
      const idOrigen = currRep[0].idMunicipio;

      await connection.query(
        'INSERT INTO transferencia (folio, idMunicipioOrigen, idMunicipioDestino, idUsuario, justificacion) VALUES (?, ?, ?, ?, ?)',
        [folio, idOrigen, idMunicipioDestino, idUsuario, justificacion || '']
      );
      await connection.query('UPDATE reporte SET idMunicipio = ? WHERE folio = ?', [idMunicipioDestino, folio]);
    } else if (tipo === 'CANALIZACION_PPNNA') {
      await connection.query(
        'INSERT INTO canalizacion_estatal (folio, numero_oficio, idUsuario) VALUES (?, ?, ?)',
        [folio, numero_oficio, idUsuario]
      );
      await connection.query('UPDATE reporte SET estatus = "Canalizado PPNNA" WHERE folio = ?', [folio]);
    } else if (tipo === 'DESCARTE') {
      await connection.query(
        'INSERT INTO descarte (folio, motivo, justificacion, idUsuario) VALUES (?, ?, ?, ?)',
        [folio, motivo, justificacion || '', idUsuario]
      );
      await connection.query('UPDATE reporte SET estatus = "Descartado" WHERE folio = ?', [folio]);
    }

    await connection.commit();
    res.json({ message: `Movimiento de tipo ${tipo} procesado exitosamente` });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

export const handler = serverlessExpress({ app });