-- =========================================================================
-- RIETI - Migracion: limites de los campos de texto libre del reporte
-- Correr UNA sola vez sobre una base ya creada.
-- =========================================================================
--
-- Antes:  descripcion TEXT           (sin limite practico)
--         referencias VARCHAR(255)
--
-- Despues: descripcion VARCHAR(500)
--          referencias VARCHAR(100)
--
-- El backend valida las mismas longitudes antes de insertar (MAX_DESCRIPCION
-- y MAX_REFERENCIAS en app.mjs), asi que un reporte demasiado largo se
-- rechaza con 400 y nunca llega a la base.
-- =========================================================================

USE rieti;

-- -------------------------------------------------------------------------
-- 1. Revisar si ya hay datos que no entrarian en el nuevo limite.
--    Si esta consulta devuelve renglones, HAY QUE RESOLVERLOS ANTES,
--    porque el ALTER los truncaria sin avisar.
-- -------------------------------------------------------------------------

SELECT
    folio,
    CHAR_LENGTH(descripcion) AS largo_descripcion,
    CHAR_LENGTH(referencias) AS largo_referencias
FROM reporte
WHERE CHAR_LENGTH(descripcion) > 500
   OR CHAR_LENGTH(referencias) > 100;

-- -------------------------------------------------------------------------
-- 2. Aplicar los nuevos limites.
--    Solo correr esto si la consulta de arriba salio vacia.
-- -------------------------------------------------------------------------

ALTER TABLE reporte
    MODIFY COLUMN descripcion VARCHAR(500) NOT NULL;

ALTER TABLE reporte
    MODIFY COLUMN referencias VARCHAR(100) NULL;

-- -------------------------------------------------------------------------
-- 3. Opcional pero recomendado: que la base impida registrar dos veces
--    la misma ruta de S3. El backend ya responde 409 cuando detecta el
--    duplicado; este indice es el respaldo por si alguien escribe directo
--    en la base.
--
--    Si falla con "Duplicate entry", es que ya hay keys repetidas:
--    hay que limpiarlas antes de crear el indice.
-- -------------------------------------------------------------------------

ALTER TABLE evidencia
    ADD CONSTRAINT uq_evidencia_ruta UNIQUE (ruta_s3);

-- -------------------------------------------------------------------------
-- 4. Verificacion
-- -------------------------------------------------------------------------

SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'rieti'
  AND TABLE_NAME = 'reporte'
  AND COLUMN_NAME IN ('descripcion', 'referencias');

SHOW INDEX FROM evidencia WHERE Key_name = 'uq_evidencia_ruta';
