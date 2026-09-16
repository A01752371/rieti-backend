DROP DATABASE IF EXISTS rieti;

CREATE DATABASE rieti
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE rieti;

CREATE TABLE rol (
    idRol   INT          NOT NULL AUTO_INCREMENT,
    nombre  VARCHAR(50)  NOT NULL,
    PRIMARY KEY (idRol),
    UNIQUE KEY uq_rol_nombre (nombre)
) ENGINE=InnoDB;

CREATE TABLE municipio (
    idMunicipio     INT          NOT NULL AUTO_INCREMENT,
    nombre          VARCHAR(100) NOT NULL,
    clave_inegi     VARCHAR(5)   NOT NULL,
    adherido_rieti  BOOLEAN      NOT NULL DEFAULT FALSE,
    contador        INT          NOT NULL DEFAULT 0,
    PRIMARY KEY (idMunicipio),
    UNIQUE KEY uq_municipio_inegi (clave_inegi)
) ENGINE=InnoDB;

CREATE TABLE catalogo_actividad (
    idCatalogoActividad INT          NOT NULL AUTO_INCREMENT,
    nombre              VARCHAR(100) NOT NULL,
    PRIMARY KEY (idCatalogoActividad),
    UNIQUE KEY uq_actividad_nombre (nombre)
) ENGINE=InnoDB;

CREATE TABLE usuario (
    idUsuario            INT          NOT NULL AUTO_INCREMENT,
    nombre               VARCHAR(150) NOT NULL,
    correo_institucional VARCHAR(150) NOT NULL,
    telefono             VARCHAR(20)  NULL,
    password_hash        VARCHAR(255) NOT NULL,
    idRol                INT          NOT NULL,
    idMunicipio          INT          NOT NULL,
    activo               BOOLEAN      NOT NULL DEFAULT TRUE,
    ultimo_acceso        TIMESTAMP    NULL,
    PRIMARY KEY (idUsuario),
    UNIQUE KEY uq_usuario_correo (correo_institucional),
    KEY idx_usuario_municipio (idMunicipio),
    CONSTRAINT fk_usuario_rol
        FOREIGN KEY (idRol) REFERENCES rol (idRol)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_usuario_municipio
        FOREIGN KEY (idMunicipio) REFERENCES municipio (idMunicipio)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE reporte (
    folio                 VARCHAR(30)    NOT NULL,
    modalidad             VARCHAR(20)    NOT NULL,
    correo_contacto       VARCHAR(150)   NULL,
    num_menores           INT            NOT NULL,
    rango_edad            VARCHAR(50)    NOT NULL,
    genero_observado      VARCHAR(20)    NOT NULL,
    idCatalogoActividad   INT            NOT NULL,
    hora_observada        TIME           NOT NULL,
    descripcion           TEXT           NOT NULL,
    situacion_riesgo      BOOLEAN        NOT NULL DEFAULT FALSE,
    latitud               DECIMAL(10,8)  NOT NULL,
    longitud              DECIMAL(11,8)  NOT NULL,
    calle                 VARCHAR(150)   NOT NULL,
    colonia               VARCHAR(100)   NOT NULL,
    cp                    VARCHAR(10)    NULL,
    referencias           VARCHAR(255)   NULL,
    idMunicipio           INT            NOT NULL,
    estatus               VARCHAR(30)    NOT NULL DEFAULT 'Recibido',
    prioridad             VARCHAR(20)    NOT NULL DEFAULT 'Media',
    fecha_registro        TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_ultima_atencion TIMESTAMP      NULL,
    hash_sha256           CHAR(64)       NOT NULL,
    acepto_aviso          BOOLEAN        NOT NULL,
    fecha_aceptacion      TIMESTAMP      NOT NULL,
    PRIMARY KEY (folio),
    KEY idx_reporte_municipio (idMunicipio),
    KEY idx_reporte_estatus (estatus),
    KEY idx_reporte_fecha (fecha_registro),
    KEY idx_reporte_actividad (idCatalogoActividad),
    CONSTRAINT fk_reporte_municipio
        FOREIGN KEY (idMunicipio) REFERENCES municipio (idMunicipio)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_reporte_actividad
        FOREIGN KEY (idCatalogoActividad) REFERENCES catalogo_actividad (idCatalogoActividad)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE evidencia (
    idEvidencia  INT          NOT NULL AUTO_INCREMENT,
    folio        VARCHAR(30)  NOT NULL,
    ruta_s3      VARCHAR(500) NOT NULL,
    fecha_carga  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_purga  TIMESTAMP    NOT NULL,
    PRIMARY KEY (idEvidencia),
    KEY idx_evidencia_folio (folio),
    CONSTRAINT fk_evidencia_reporte
        FOREIGN KEY (folio) REFERENCES reporte (folio)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE asignacion (
    idAsignacion     INT         NOT NULL AUTO_INCREMENT,
    folio            VARCHAR(30) NOT NULL,
    idUsuario        INT         NOT NULL,
    fecha_asignacion TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (idAsignacion),
    UNIQUE KEY uq_asignacion_folio (folio),
    KEY idx_asignacion_usuario (idUsuario),
    CONSTRAINT fk_asignacion_reporte
        FOREIGN KEY (folio) REFERENCES reporte (folio)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_asignacion_usuario
        FOREIGN KEY (idUsuario) REFERENCES usuario (idUsuario)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE bitacora (
    idBitacora   INT          NOT NULL AUTO_INCREMENT,
    folio        VARCHAR(30)  NOT NULL,
    idUsuario    INT          NOT NULL,
    fecha        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    accion       VARCHAR(100) NOT NULL,
    nota_interna TEXT         NOT NULL,
    PRIMARY KEY (idBitacora),
    KEY idx_bitacora_folio (folio),
    KEY idx_bitacora_usuario (idUsuario),
    CONSTRAINT fk_bitacora_reporte
        FOREIGN KEY (folio) REFERENCES reporte (folio)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_bitacora_usuario
        FOREIGN KEY (idUsuario) REFERENCES usuario (idUsuario)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE historial_estatus (
    idHistorialEstatus INT         NOT NULL AUTO_INCREMENT,
    folio              VARCHAR(30) NOT NULL,
    estatus_anterior   VARCHAR(30) NOT NULL,
    estatus_nuevo      VARCHAR(30) NOT NULL,
    idUsuario          INT         NOT NULL,
    justificacion      TEXT        NOT NULL,
    fecha              TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (idHistorialEstatus),
    KEY idx_historial_folio (folio),
    KEY idx_historial_usuario (idUsuario),
    CONSTRAINT fk_historial_reporte
        FOREIGN KEY (folio) REFERENCES reporte (folio)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_historial_usuario
        FOREIGN KEY (idUsuario) REFERENCES usuario (idUsuario)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE transferencia (
    idTransferencia    INT         NOT NULL AUTO_INCREMENT,
    folio              VARCHAR(30) NOT NULL,
    idMunicipioOrigen  INT         NOT NULL,
    idMunicipioDestino INT         NOT NULL,
    idUsuario          INT         NOT NULL,
    justificacion      TEXT        NOT NULL,
    fecha              TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (idTransferencia),
    KEY idx_transferencia_folio (folio),
    KEY idx_transferencia_origen (idMunicipioOrigen),
    KEY idx_transferencia_destino (idMunicipioDestino),
    KEY idx_transferencia_usuario (idUsuario),
    CONSTRAINT fk_transferencia_reporte
        FOREIGN KEY (folio) REFERENCES reporte (folio)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_transferencia_origen
        FOREIGN KEY (idMunicipioOrigen) REFERENCES municipio (idMunicipio)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_transferencia_destino
        FOREIGN KEY (idMunicipioDestino) REFERENCES municipio (idMunicipio)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_transferencia_usuario
        FOREIGN KEY (idUsuario) REFERENCES usuario (idUsuario)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE canalizacion_estatal (
    idCanalizacionEstatal INT          NOT NULL AUTO_INCREMENT,
    folio                 VARCHAR(30)  NOT NULL,
    numero_oficio         VARCHAR(100) NOT NULL,
    idUsuario             INT          NOT NULL,
    fecha                 TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (idCanalizacionEstatal),
    UNIQUE KEY uq_canalizacion_folio (folio),
    KEY idx_canalizacion_usuario (idUsuario),
    CONSTRAINT fk_canalizacion_reporte
        FOREIGN KEY (folio) REFERENCES reporte (folio)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_canalizacion_usuario
        FOREIGN KEY (idUsuario) REFERENCES usuario (idUsuario)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE descarte (
    idDescarte    INT          NOT NULL AUTO_INCREMENT,
    folio         VARCHAR(30)  NOT NULL,
    motivo        VARCHAR(100) NOT NULL,
    justificacion TEXT         NOT NULL,
    idUsuario     INT          NOT NULL,
    fecha         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (idDescarte),
    UNIQUE KEY uq_descarte_folio (folio),
    KEY idx_descarte_usuario (idUsuario),
    CONSTRAINT fk_descarte_reporte
        FOREIGN KEY (folio) REFERENCES reporte (folio)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_descarte_usuario
        FOREIGN KEY (idUsuario) REFERENCES usuario (idUsuario)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE notificacion (
    idNotificacion INT          NOT NULL AUTO_INCREMENT,
    folio          VARCHAR(30)  NOT NULL,
    destinatario   VARCHAR(150) NOT NULL,
    tipo           VARCHAR(50)  NOT NULL,
    fecha_envio    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    estatus_envio  VARCHAR(20)  NOT NULL,
    PRIMARY KEY (idNotificacion),
    KEY idx_notificacion_folio (folio),
    CONSTRAINT fk_notificacion_reporte
        FOREIGN KEY (folio) REFERENCES reporte (folio)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT INTO rol (nombre) VALUES
    ('Administrador'),
    ('Alimentador');

INSERT INTO municipio (nombre, clave_inegi, adherido_rieti) VALUES
    ('Atizapan de Zaragoza', '15013', TRUE),
    ('Tlalnepantla de Baz', '15104', TRUE),
    ('Ecatepec de Morelos', '15033', TRUE),
    ('Cuautitlan Izcalli', '15121', TRUE),
    ('Tultitlan', '15109', TRUE),
    ('Coacalco de Berriozabal', '15020', TRUE),
    ('Toluca', '15106', FALSE);

INSERT INTO catalogo_actividad (nombre) VALUES
    ('Venta de productos en via publica'),
    ('Mendicidad'),
    ('Trabajo en comercio local'),
    ('Construccion'),
    ('Limpieza de parabrisas'),
    ('Actividades agricolas'),
    ('Otra');

USE rieti;
SHOW TABLES;
