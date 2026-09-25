-- seed_pruebas.sql
-- Datos ficticios para probar el sistema. NO van a producción.
-- Requiere que schema_rieti.sql ya se haya ejecutado.
-- Se puede correr las veces que se quiera: vacía las tablas antes de llenarlas.

USE rieti;

SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE notificacion;
TRUNCATE TABLE evidencia;
TRUNCATE TABLE descarte;
TRUNCATE TABLE canalizacion_estatal;
TRUNCATE TABLE transferencia;
TRUNCATE TABLE historial_estatus;
TRUNCATE TABLE bitacora;
TRUNCATE TABLE asignacion;
TRUNCATE TABLE reporte;
TRUNCATE TABLE usuario;
SET FOREIGN_KEY_CHECKS = 1;

-- =========================================================================
-- USUARIOS
-- La contraseña se guarda en texto plano mientras el login no use bcrypt.
-- Para todos: Rieti2026
-- =========================================================================

INSERT INTO usuario (nombre, correo_institucional, telefono, password_hash, idRol, idMunicipio, activo) VALUES
('Ana Lucia Martinez Rivas',  'admin.sipinna@edomex.gob.mx',           '5512345678', 'Rieti2026', 1, 1, TRUE),
('Carlos Hernandez Pena',     'procurador.tlalnepantla@edomex.gob.mx', '5523456789', 'Rieti2026', 2, 2, TRUE),
('Laura Sanchez Dominguez',   'procurador.ecatepec@edomex.gob.mx',     '5534567890', 'Rieti2026', 2, 3, TRUE),
('Miguel Angel Torres Cruz',  'procurador.atizapan@edomex.gob.mx',     '5545678901', 'Rieti2026', 2, 1, TRUE),
('Patricia Gomez Valdes',     'procurador.tultitlan@edomex.gob.mx',    '5556789012', 'Rieti2026', 2, 5, FALSE);

-- =========================================================================
-- REPORTES
-- Los folios usan las siglas de la tabla municipio.
-- =========================================================================

INSERT INTO reporte (folio, modalidad, correo_contacto, num_menores, rango_edad, genero_observado, idCatalogoActividad, hora_observada, descripcion, situacion_riesgo, latitud, longitud, calle, colonia, cp, referencias, idMunicipio, estatus, prioridad, fecha_registro, fecha_ultima_atencion, hash_sha256, acepto_aviso, fecha_aceptacion) VALUES
('RIETI-ATZ-2026-00001','SEGUIMIENTO','ciudadano01@correo.com',1,'6 a 11 anos','Femenino',1,'15:00:00','Observe a una nina de aproximadamente 8 anos vendiendo dulces en el crucero durante la tarde.',FALSE,19.55890000,-99.26410000,'Avenida Ruiz Cortines','Lomas de Atizapan','52977','Frente a la gasolinera El Olivo',1,'Recibido','Media','2026-08-14 15:32:00',NULL,'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',TRUE,'2026-08-14 15:32:00'),
('RIETI-TLA-2026-00001','ANONIMO','anonimo01@correo.com',3,'12 a 14 anos','Ambos',5,'08:15:00','Tres adolescentes limpiando parabrisas en la avenida principal durante hora pico, sin supervision adulta.',TRUE,19.54040000,-99.19520000,'Avenida Juarez','Centro','54000','Cerca del puente peatonal',2,'En Revision','Alta','2026-08-16 08:40:00','2026-08-18 10:12:00','b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3',TRUE,'2026-08-16 08:40:00'),
('RIETI-ECA-2026-00001','SEGUIMIENTO','vecina.preocupada@correo.com',2,'6 a 11 anos','Masculino',3,'17:45:00','Dos ninos atendiendo un puesto de frutas en el mercado sin acompanamiento de adultos por varias horas.',FALSE,19.60110000,-99.05050000,'Calle Morelos','San Cristobal Centro','55000','Junto al mercado municipal',3,'En Proceso','Media','2026-08-17 18:02:00','2026-08-21 09:30:00','c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4',TRUE,'2026-08-17 18:02:00'),
('RIETI-ATZ-2026-00002','ANONIMO','anonimo02@correo.com',1,'15 a 17 anos','Masculino',4,'11:20:00','Adolescente cargando material de construccion en una obra sin equipo de proteccion personal.',TRUE,19.57200000,-99.25100000,'Boulevard Adolfo Lopez Mateos','Las Alamedas','52970','Obra en construccion esquina con Hidalgo',1,'En Proceso','Alta','2026-08-19 11:55:00','2026-08-22 14:20:00','d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5',TRUE,'2026-08-19 11:55:00'),
('RIETI-TLA-2026-00002','SEGUIMIENTO','denuncia.anonima22@correo.com',2,'0 a 5 anos','Femenino',2,'19:30:00','Dos menores muy pequenos pidiendo dinero en el semaforo acompanados por un adulto.',TRUE,19.53200000,-99.20180000,'Calzada Vallejo','San Juan Ixhuatepec','54180','Semaforo de la entrada a la colonia',2,'Concluido','Alta','2026-08-20 19:50:00','2026-09-02 16:00:00','e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6',TRUE,'2026-08-20 19:50:00'),
('RIETI-ECA-2026-00002','ANONIMO','anonimo03@correo.com',4,'12 a 14 anos','Ambos',1,'14:00:00','Grupo de menores vendiendo articulos en los vagones del transporte publico.',FALSE,19.59300000,-99.06700000,'Avenida Central','Ciudad Azteca','55120','Paradero del transporte',3,'Concluido','Media','2026-08-22 14:25:00','2026-09-05 11:45:00','f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7',TRUE,'2026-08-22 14:25:00'),
('RIETI-CIZ-2026-00001','SEGUIMIENTO','reporte.ciudadano@correo.com',1,'6 a 11 anos','Femenino',1,'16:10:00','Nina vendiendo flores afuera de un centro comercial por las tardes de manera recurrente.',FALSE,19.64620000,-99.20530000,'Avenida Jinetes','Cumbria','54740','Afuera del centro comercial',4,'Recibido','Baja','2026-08-25 16:30:00',NULL,'a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8',TRUE,'2026-08-25 16:30:00'),
('RIETI-TLT-2026-00001','ANONIMO','anonimo04@correo.com',2,'15 a 17 anos','Masculino',6,'07:00:00','Adolescentes trabajando en labores del campo desde muy temprano en horario escolar.',FALSE,19.64500000,-99.16800000,'Camino a Santa Maria','Buenavista','54910','Parcelas al norte del pueblo',5,'En Revision','Media','2026-08-27 07:45:00','2026-08-29 12:00:00','b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9',TRUE,'2026-08-27 07:45:00'),
('RIETI-COA-2026-00001','SEGUIMIENTO','testigo.caso@correo.com',1,'12 a 14 anos','Femenino',3,'13:25:00','Menor atendiendo una fonda durante el horario en que deberia estar en la escuela.',FALSE,19.62800000,-99.09800000,'Avenida Jose Lopez Portillo','Villa de las Flores','55710','Fonda en la avenida principal',6,'Reincidencia','Alta','2026-08-28 13:50:00','2026-09-08 10:15:00','c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0',TRUE,'2026-08-28 13:50:00'),
('RIETI-TOL-2026-00001','SEGUIMIENTO','ciudadana.toluca@correo.com',2,'6 a 11 anos','Ambos',2,'18:00:00','Dos menores pidiendo dinero en la zona centro durante la noche.',TRUE,19.29260000,-99.65690000,'Portal Madero','Centro','50000','Portales del centro historico',7,'Canalizado','Alta','2026-08-30 18:20:00','2026-09-03 09:00:00','d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1',TRUE,'2026-08-30 18:20:00'),
('RIETI-ATZ-2026-00003','ANONIMO','anonimo05@correo.com',1,'12 a 14 anos','Masculino',1,'20:15:00','Menor vendiendo chicles en la salida del metro durante la noche.',FALSE,19.56800000,-99.24300000,'Avenida Hidalgo','El Chaparral','52975','Salida del paradero',1,'Cancelado','Baja','2026-09-01 20:40:00','2026-09-04 15:30:00','e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2',TRUE,'2026-09-01 20:40:00'),
('RIETI-TLA-2026-00003','SEGUIMIENTO','reporta.vecino@correo.com',3,'6 a 11 anos','Ambos',1,'12:30:00','Tres menores vendiendo productos en el tianguis los fines de semana.',FALSE,19.53900000,-99.18700000,'Calle 5 de Mayo','Tlalnepantla Centro','54000','Tianguis dominical',2,'Recibido','Media','2026-09-06 12:55:00',NULL,'f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3',TRUE,'2026-09-06 12:55:00');

-- =========================================================================
-- ASIGNACIONES
-- =========================================================================

INSERT INTO asignacion (folio, idUsuario, fecha_asignacion) VALUES
('RIETI-TLA-2026-00001', 2, '2026-08-18 10:12:00'),
('RIETI-ECA-2026-00001', 3, '2026-08-21 09:30:00'),
('RIETI-ATZ-2026-00002', 4, '2026-08-22 14:20:00'),
('RIETI-TLA-2026-00002', 2, '2026-08-25 09:00:00'),
('RIETI-ECA-2026-00002', 3, '2026-08-26 11:00:00'),
('RIETI-TLT-2026-00001', 5, '2026-08-29 12:00:00'),
('RIETI-COA-2026-00001', 4, '2026-09-08 10:15:00');

-- =========================================================================
-- BITACORA
-- =========================================================================

INSERT INTO bitacora (folio, idUsuario, fecha, accion, nota_interna) VALUES
('RIETI-TLA-2026-00001', 2, '2026-08-18 10:20:00', 'Valoracion inicial', 'Se clasifica como riesgo alto por exposicion vial. Se programa visita de campo.'),
('RIETI-TLA-2026-00001', 2, '2026-08-19 16:40:00', 'Visita de campo', 'Se acude al punto senalado. No se localiza a los menores en el horario indicado.'),
('RIETI-ECA-2026-00001', 3, '2026-08-21 09:45:00', 'Valoracion inicial', 'Caso derivado de comercio familiar. Se contacta a la administracion del mercado.'),
('RIETI-ECA-2026-00001', 3, '2026-08-24 11:15:00', 'Entrevista', 'Se entrevista al responsable del puesto. Se orienta sobre la normatividad aplicable.'),
('RIETI-ATZ-2026-00002', 4, '2026-08-22 14:35:00', 'Valoracion inicial', 'Riesgo alto por actividad peligrosa. Se notifica a inspeccion municipal de obras.'),
('RIETI-ATZ-2026-00002', 4, '2026-08-26 10:00:00', 'Visita de campo', 'Se verifica la obra en compania de inspeccion. Se levanta acta correspondiente.'),
('RIETI-TLA-2026-00002', 2, '2026-08-25 09:30:00', 'Canalizacion interna', 'Se canaliza a DIF municipal para valoracion de la situacion familiar.'),
('RIETI-TLA-2026-00002', 2, '2026-09-02 15:50:00', 'Cierre', 'Familia incorporada a programa de apoyo. Se concluye la intervencion.'),
('RIETI-ECA-2026-00002', 3, '2026-09-05 11:30:00', 'Cierre', 'Operativo conjunto con transporte publico. Se concluye el expediente.'),
('RIETI-TLT-2026-00001', 5, '2026-08-29 12:20:00', 'Valoracion inicial', 'Se solicita apoyo de la autoridad agraria para identificar el predio.'),
('RIETI-COA-2026-00001', 4, '2026-09-08 10:30:00', 'Reapertura', 'Nuevo reporte en la misma ubicacion. Se vincula con antecedente y se reactiva.');

-- =========================================================================
-- HISTORIAL DE ESTATUS
-- =========================================================================

INSERT INTO historial_estatus (folio, estatus_anterior, estatus_nuevo, idUsuario, justificacion, fecha) VALUES
('RIETI-TLA-2026-00001','Recibido','En Revision',2,'Se asigna a procurador municipal para valoracion.','2026-08-18 10:12:00'),
('RIETI-ECA-2026-00001','Recibido','En Revision',3,'Se asigna a procurador municipal para valoracion.','2026-08-21 09:30:00'),
('RIETI-ECA-2026-00001','En Revision','En Proceso',3,'Se inicia intervencion en campo.','2026-08-24 11:00:00'),
('RIETI-ATZ-2026-00002','Recibido','En Revision',4,'Caso prioritario por riesgo fisico.','2026-08-22 14:20:00'),
('RIETI-ATZ-2026-00002','En Revision','En Proceso',4,'Se coordina operativo con inspeccion municipal.','2026-08-26 09:50:00'),
('RIETI-TLA-2026-00002','Recibido','En Revision',2,'Se asigna para atencion inmediata.','2026-08-25 09:00:00'),
('RIETI-TLA-2026-00002','En Revision','En Proceso',2,'Canalizacion a DIF municipal en curso.','2026-08-27 10:30:00'),
('RIETI-TLA-2026-00002','En Proceso','Concluido',2,'Se concluye la intervencion. Familia incorporada a programa de apoyo social.','2026-09-02 16:00:00'),
('RIETI-ECA-2026-00002','Recibido','En Proceso',3,'Se integra a operativo programado en transporte publico.','2026-08-26 11:00:00'),
('RIETI-ECA-2026-00002','En Proceso','Concluido',3,'Operativo realizado. Se orienta a los responsables y se cierra el caso.','2026-09-05 11:45:00'),
('RIETI-TLT-2026-00001','Recibido','En Revision',5,'Se solicita informacion adicional sobre el predio.','2026-08-29 12:00:00'),
('RIETI-COA-2026-00001','Recibido','En Proceso',4,'Se inicia valoracion del caso.','2026-08-29 10:00:00'),
('RIETI-COA-2026-00001','En Proceso','Concluido',4,'Se orienta al responsable del establecimiento.','2026-09-05 17:00:00'),
('RIETI-COA-2026-00001','Concluido','Reincidencia',4,'Se recibe nuevo reporte en la misma ubicacion. Se reactiva el expediente.','2026-09-08 10:15:00'),
('RIETI-TOL-2026-00001','Recibido','Canalizado',1,'Municipio no adherido a la red RIETI. Se remite a la PPNNA.','2026-09-03 09:00:00'),
('RIETI-ATZ-2026-00003','Recibido','Cancelado',1,'Reporte duplicado del folio RIETI-ATZ-2026-00001.','2026-09-04 15:30:00');

-- =========================================================================
-- TRANSFERENCIA, CANALIZACION Y DESCARTE
-- =========================================================================

INSERT INTO transferencia (folio, idMunicipioOrigen, idMunicipioDestino, idUsuario, justificacion, fecha) VALUES
('RIETI-COA-2026-00001', 3, 6, 1, 'La ubicacion reportada corresponde a la demarcacion de Coacalco y no a Ecatepec.', '2026-08-29 09:30:00');

INSERT INTO canalizacion_estatal (folio, numero_oficio, idUsuario, fecha) VALUES
('RIETI-TOL-2026-00001', 'SIPINNA/EDOMEX/2026/0457', 1, '2026-09-03 09:00:00');

INSERT INTO descarte (folio, motivo, justificacion, idUsuario, fecha) VALUES
('RIETI-ATZ-2026-00003', 'Duplicado', 'El reporte corresponde al mismo hecho ya registrado en el folio RIETI-ATZ-2026-00001.', 1, '2026-09-04 15:30:00');

-- =========================================================================
-- EVIDENCIAS
-- =========================================================================

INSERT INTO evidencia (folio, ruta_s3, fecha_carga, fecha_purga) VALUES
('RIETI-ATZ-2026-00001','evidencias/RIETI-ATZ-2026-00001/1755183120_foto1.jpg','2026-08-14 15:32:00','2026-08-24 15:32:00'),
('RIETI-TLA-2026-00001','evidencias/RIETI-TLA-2026-00001/1755337200_foto1.jpg','2026-08-16 08:40:00','2026-08-26 08:40:00'),
('RIETI-TLA-2026-00001','evidencias/RIETI-TLA-2026-00001/1755337260_foto2.jpg','2026-08-16 08:41:00','2026-08-26 08:41:00'),
('RIETI-ATZ-2026-00002','evidencias/RIETI-ATZ-2026-00002/1755604500_foto1.jpg','2026-08-19 11:55:00','2026-08-29 11:55:00'),
('RIETI-ECA-2026-00002','evidencias/RIETI-ECA-2026-00002/1755872700_foto1.jpg','2026-08-22 14:25:00','2026-09-01 14:25:00');

-- =========================================================================
-- NOTIFICACIONES
-- =========================================================================

INSERT INTO notificacion (folio, destinatario, tipo, fecha_envio, estatus_envio) VALUES
('RIETI-ATZ-2026-00001','ciudadano01@correo.com','Folio','2026-08-14 15:32:10','ENVIADO'),
('RIETI-ECA-2026-00001','vecina.preocupada@correo.com','Folio','2026-08-17 18:02:08','ENVIADO'),
('RIETI-ECA-2026-00001','vecina.preocupada@correo.com','ActualizacionEstatus','2026-08-24 11:05:00','ENVIADO'),
('RIETI-TLA-2026-00002','denuncia.anonima22@correo.com','Folio','2026-08-20 19:50:12','ENVIADO'),
('RIETI-TLA-2026-00002','denuncia.anonima22@correo.com','Cierre','2026-09-02 16:00:30','ENVIADO'),
('RIETI-CIZ-2026-00001','reporte.ciudadano@correo.com','Folio','2026-08-25 16:30:05','ENVIADO'),
('RIETI-COA-2026-00001','testigo.caso@correo.com','Folio','2026-08-28 13:50:07','ENVIADO'),
('RIETI-COA-2026-00001','testigo.caso@correo.com','ActualizacionEstatus','2026-09-08 10:16:00','FALLIDO'),
('RIETI-TOL-2026-00001','ciudadana.toluca@correo.com','Folio','2026-08-30 18:20:09','ENVIADO'),
('RIETI-TLA-2026-00003','reporta.vecino@correo.com','Folio','2026-09-06 12:55:06','ENVIADO');

-- =========================================================================
-- Sincronizar el contador de folios de cada municipio con lo ya insertado,
-- para que el backend siga la numeracion sin repetir folios.
-- =========================================================================

UPDATE municipio m SET contador = (
    SELECT COUNT(*) FROM reporte r WHERE r.idMunicipio = m.idMunicipio
);
