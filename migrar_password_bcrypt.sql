-- migrar_password_bcrypt.sql
-- Convierte las contraseñas de texto plano a hashes de bcrypt.
-- Correr UNA sola vez, después de subir la version del backend que usa bcrypt.
-- La contraseña de los 5 usuarios queda en: Rieti2026

USE rieti;

UPDATE usuario SET password_hash = '$2b$10$L33P.l9IGRyzjFmgE5dDRevNoImhhewbCnll3fC/xKoAlzwzaDZWm' WHERE idUsuario = 1;
UPDATE usuario SET password_hash = '$2b$10$6w2Fnw8xPChy9rC4fRS.7eHpanIh6U52fnljJLs8x5OaTs3H1061.' WHERE idUsuario = 2;
UPDATE usuario SET password_hash = '$2b$10$kHgJ8mwEix7Ajz87dkojK.k80UHn4pc.bbtXI9qEbCBE1ylw2Pav6' WHERE idUsuario = 3;
UPDATE usuario SET password_hash = '$2b$10$TizGL08..67Z5YBl22qDve1DPjjYoY5nwhzGqF.nOdeBYGMCF3Q.y' WHERE idUsuario = 4;
UPDATE usuario SET password_hash = '$2b$10$EPsvY3enW28XS.DI1UXble4iNmElN94rmoE0E37WTBxMdYZov3/P6' WHERE idUsuario = 5;

-- Comprobar que los 5 quedaron con hash (deben empezar con $2b$10$)
SELECT idUsuario, nombre, LEFT(password_hash, 7) AS inicio_hash FROM usuario;
