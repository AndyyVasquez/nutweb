const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const Buffer = require('buffer').Buffer;
const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
};

async function getMongoConnection() {
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  return client.db(process.env.MONGO_DB);
}
// Obtener pasos por usuario
router.get('/pasos/:id_cli', async (req, res) => {
  const { id_cli } = req.params;
  try {
    const db = await getMongoConnection();
    const pasos = await db
      .collection('pasos')
      .find({ id_cli: parseInt(id_cli) })
      .sort({ fecha: 1 })
      .toArray();
    res.json(pasos);
  } catch (error) {
    console.error('Error al obtener pasos:', error);
    res.status(500).json({ error: 'Error al obtener datos de pasos' });
  }
});

// Obtener dietas por id de cliente
router.get('/obdietas/:id_cliente', async (req, res) => {
  const idCliente = req.params.id_cliente;
  try {
    const connection = await mysql.createConnection(dbConfig);
    try {
      const query = `SELECT ...`;
      const [results] = await connection.execute(query, [idCliente]);
      res.json(results);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error al obtener dietas por cliente:', error);
    res.status(500).json({ error: 'Error al obtener las dietas del cliente' });
  }
});





router.put('/nutriologos/:id/verificar', (req, res) => {
  const id = req.params.id;
  const fechaHoy = new Date().toISOString().split('T')[0]; // formato 'YYYY-MM-DD'

  const sql = `
    UPDATE nutriologos
    SET verificado = ?,
        fecha_inicio_sub = IF(fecha_inicio_sub IS NULL, ?, fecha_inicio_sub),
        tiene_acceso = 1
    WHERE id_nut = ?
  `;

  connection.query(sql, ['aprobado', fechaHoy, id], (error, result) => {
    if (error) {
      console.error('Error al actualizar verificado:', error);
      return res.status(500).json({ message: 'Error del servidor' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Nutriólogo no encontrado' });
    }

    return res.json({ message: 'Nutriólogo aprobado correctamente' });
  });
});


router.put('/nutriologos/:id/denegar', (req, res) => {
  const id = req.params.id;

  const sql = `
    UPDATE nutriologos
    SET verificado = 'denegado',
        tiene_acceso = 0
    WHERE id_nut = ?
  `;

  connection.query(sql, [id], (error, result) => {
    if (error) {
      console.error('Error al denegar nutriólogo:', error);
      return res.status(500).json({ message: 'Error del servidor' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Nutriólogo no encontrado' });
    }

    return res.json({ message: 'Nutriólogo rechazado correctamente' });
  });
});



// Ruta para obtener todos los nutriólogos
router.get('/nutriologos', (req, res) => {
  connection.query('SELECT * FROM nutriologos', (error, rows) => {
    if (error) {
      console.error('Error en /nutriologos:', error);
      return res.status(500).json({ message: 'Error en el servidor' });
    }
    res.json(rows);
  });
});


// Registro de nutriólogo
router.post('/nutriologos/registro', async (req, res) => {
  const {
    nombre_nut,
    app_nut,
    apm_nut,
    correo,
    password,
    cedula_nut,
    especialidad_nut,
    telefono_nut,
    token_vinculacion,
  } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const sql = `
      INSERT INTO nutriologos
      (nombre_nut, app_nut, apm_nut, correo, password, cedula_nut, especialidad_nut, telefono_nut, token_vinculacion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(
      sql,
      [
        nombre_nut,
        app_nut,
        apm_nut,
        correo,
        hashedPassword,
        cedula_nut,
        especialidad_nut,
        telefono_nut,
        token_vinculacion,
      ],
      (err, result) => {
        if (err) {
          console.error('Error en el registro:', err);
          return res.status(500).json({ error: 'Correo o token ya registrados' });
        }

        res.status(201).json({ message: 'Nutriólogo registrado exitosamente' });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// LOGIN - nutriólogos o administradores 
router.post('/nutriologos/login', (req, res) => {
  const { correo, password } = req.body;

  const sqlNutri = `SELECT id_nut AS id, nombre_nut AS nombre, password, token, verificado, tiene_acceso, tipo_usu, 'nutriologo' AS rol FROM nutriologos WHERE correo = ?`;

  db.query(sqlNutri, [correo], async (err, results) => {
    if (err) return res.status(500).json({ error: 'Error en el servidor' });

    if (results.length > 0) {
      const nutri = results[0];
if (nutri.verificado == 'pendiente') {
      return res.status(403).json({ error: 'Solicitud de registro aún no ha aprobada. Intenta más tarde.' });
    }
    
    if (nutri.verificado == 'denegado') {
      return res.status(403).json({ error: 'Solicitud de registro denegada. Si crees que se trata de un error favor de comunicarse con soporte através de nutralis@gmail.com' });
    }

      if (nutri.token) {
        return res.status(403).json({ error: 'Sesión ya activa' });
      }

      const match = await bcrypt.compare(password, nutri.password);
      if (!match) return res.status(401).json({ error: 'Contraseña incorrecta' });

      const newToken = uuidv4();
      db.query(
        `UPDATE nutriologos SET token = ? WHERE id_nut = ?`,
        [newToken, nutri.id],
        (err2) => {
          if (err2) return res.status(500).json({ error: 'Error al guardar token' });

          res.json({
            message: 'Inicio de sesión exitoso (nutriólogo)',
            id_nut: nutri.id,
            nombre: nutri.nombre,
            token: newToken,
            tipo_usu: nutri.tipo_usu,
            rol: 'nutriologo'
          });
        }
      );
    } else {
      const sqlAdmin = `SELECT id_admin AS id, nombre_admin AS nombre, password, token, tipo_usu, 'admin' AS rol FROM administradores WHERE correo = ?`;

      db.query(sqlAdmin, [correo], async (err, resultsAdmin) => {
        if (err) return res.status(500).json({ error: 'Error en el servidor' });

        if (resultsAdmin.length === 0) {
          return res.status(404).json({ error: 'Correo no registrado' });
        }

        const admin = resultsAdmin[0];

        if (admin.token) {
          return res.status(403).json({ error: 'Sesión ya activa en otro dispositivo' });
        }

        const match = await bcrypt.compare(password, admin.password);
        if (!match) return res.status(401).json({ error: 'Contraseña incorrecta' });

        const newToken = uuidv4();
        db.query(
          `UPDATE administradores SET token = ? WHERE id_admin = ?`,
          [newToken, admin.id],
          (err2) => {
            if (err2) return res.status(500).json({ error: 'Error al guardar token' });

            res.json({
              message: 'Inicio de sesión exitoso (administrador)',
              id_nut: admin.id, // para mantener la clave en frontend
              nombre: admin.nombre,
              token: newToken,
              tipo_usu: admin.tipo_usu,
              rol: 'admin'
            });
          }
        );
      });
    }
  });
});

// LOGOUT 
router.post('/nutriologos/logout', (req, res) => {
  const { id, rol } = req.body;

  // Validación de datos
  if (!id || !rol) {
    return res.status(400).json({ error: 'Datos incompletos para cerrar sesión' });
  }

  // Determinar tabla y campo según el rol
  const tabla = rol === 'admin' ? 'administradores' : 'nutriologos';
  const campo = rol === 'admin' ? 'id_admin' : 'id_nut';

  // Actualizar base de datos
  db.query(
    `UPDATE ${tabla} SET token = NULL WHERE ${campo} = ?`,
    [id],
    (err, result) => {
      if (err) {
        console.error('Error en la base de datos:', err);
        return res.status(500).json({ error: 'Error al cerrar sesión' });
      }
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      
      res.json({ message: 'Sesión cerrada correctamente' });
    }
  );
});

router.post('/nutriologos/login-google', (req, res) => {
  const { correo, nombre } = req.body;
  if (!correo) return res.status(400).json({ error: 'Correo requerido' });

  const sqlNutri = `SELECT id_nut AS id, nombre_nut AS nombre, token, verificado, tiene_acceso, tipo_usu FROM nutriologos WHERE correo = ?`;

  db.query(sqlNutri, [correo], (err, results) => {
    if (err) return res.status(500).json({ error: 'Error en el servidor' });

    if (results.length > 0) {
      const nutri = results[0];

      if (nutri.verificado === 'denegado') {
        return res.status(403).json({ error: 'Solicitud de registro aún no aprobada.' });
      }

      if (nutri.tiene_acceso === 0) {
        return res.status(403).json({ error: 'No tienes acceso en este momento' });
      }

      const newToken = uuidv4();
      db.query(`UPDATE nutriologos SET token = ? WHERE id_nut = ?`, [newToken, nutri.id], (err2) => {
        if (err2) return res.status(500).json({ error: 'Error al guardar token' });

        res.json({
          message: 'Inicio de sesión exitoso (nutriólogo)',
          id_nut: nutri.id,
          nombre: nutri.nombre,
          token: newToken,
          tipo_usu: nutri.tipo_usu,
          rol: 'nutriologo',
        });
      });
    } else {
      // Opcional: crear usuario nuevo automáticamente (si lo deseas)
      // Por ahora, rechazo acceso
      res.status(404).json({ error: 'Usuario no registrado, favor registrarse' });
    }
  });
});



// Middleware para verificar token de sesión
const verifyToken = (req, res, next) => {
  const id_nut = req.headers['id_nut'];
  const token = req.headers['token'];
  const rol = req.headers['rol'];

  if (!id_nut || !token || !rol) {
    return res.status(401).json({ error: 'Faltan credenciales de autenticación' });
  }

  const tabla = rol === 'admin' ? 'administradores' : 'nutriologos';
  const campo = rol === 'admin' ? 'id_admin' : 'id_nut';

  const sql = `SELECT token FROM ${tabla} WHERE ${campo} = ?`;

  db.query(sql, [id_nut], (err, results) => {
    if (err) return res.status(500).json({ error: 'Error en la base de datos' });

    if (results.length === 0) {
      return res.status(403).json({ error: 'Usuario no encontrado' });
    }

    const tokenBD = results[0].token;

    if (!tokenBD) {
      return res.status(403).json({ error: 'No hay sesión activa' });
    }

    if (tokenBD !== token) {
      return res.status(403).json({ error: 'Token inválido' });
    }

    next();
  });
};

// objetivo de dieta activa
router.get('/cliente-objetivo/:id', (req, res) => {
  const clienteId = req.params.id;

  console.log('Cliente ID recibido:', clienteId); // 👈 Agrega esto

  if (!clienteId || isNaN(clienteId)) {
    return res.status(400).json({ message: 'ID inválido' }); // 👈 Opcional: validación básica
  }

  const query = `
    SELECT objetivo_dieta 
    FROM dietas 
    WHERE id_cli = ? AND activo = 1 
    LIMIT 1
  `;

  db.query(query, [clienteId], (err, results) => {
    if (err) {
      console.error('Error al ejecutar la consulta:', err);
      return res.status(500).json({ message: 'Error en el servidor' });
    }

    if (results.length > 0) {
      res.json({ objetivo_dieta: results[0].objetivo_dieta });
    } else {
      res.status(404).json({ message: 'No se encontró objetivo para este cliente' });
    }
  });
});

// POST para obtener clientes por nutriólogo, recibe idNutriologo en body
router.post('/clientes-por-nutriologo', (req, res) => {
  const { idNutriologo } = req.body;

  if (!idNutriologo || isNaN(idNutriologo)) {
    return res.status(400).json({ error: 'ID de nutriólogo inválido' });
  }

  const query = `
    SELECT 
      c.*, 
      a.motivo, 
      a.heredo_familiares, 
      a.no_patologicos, 
      a.patologicos, 
      a.alergias, 
      a.aversiones,
      a.fecha_registro AS fecha_registro_antecedentes
    FROM 
      clientes c
    LEFT JOIN 
      antecedentes_medicos a ON c.id_cli = a.id_cli
    WHERE 
      c.id_nut = ?
    ORDER BY 
      c.id_cli, a.fecha_registro DESC
  `;

  db.query(query, [idNutriologo], (err, clientes) => {
    if (err) {
      console.error('Error al obtener clientes:', err);
      return res.status(500).json({ error: 'Error en la base de datos' });
    }

    // Agrupar los antecedentes médicos por cliente
    const clientesAgrupados = clientes.reduce((acc, row) => {
      if (!acc[row.id_cli]) {
        acc[row.id_cli] = {
          ...row,
          antecedentes: []
        };
        delete acc[row.id_cli].motivo;
        delete acc[row.id_cli].heredo_familiares;
        delete acc[row.id_cli].no_patologicos;
        delete acc[row.id_cli].patologicos;
        delete acc[row.id_cli].alergias;
        delete acc[row.id_cli].aversiones;
        delete acc[row.id_cli].fecha_registro_antecedentes;
      }

      if (row.motivo) {
        acc[row.id_cli].antecedentes.push({
          motivo: row.motivo,
          heredo_familiares: row.heredo_familiares,
          no_patologicos: row.no_patologicos,
          patologicos: row.patologicos,
          alergias: row.alergias,
          aversiones: row.aversiones,
          fecha_registro: row.fecha_registro_antecedentes
        });
      }

      return acc;
    }, {});

    res.json(Object.values(clientesAgrupados));
  });
});


// POST para obtener cliente por id, recibe idCliente en body
router.post('/cliente-detalle', (req, res) => {
  const { idCliente } = req.body;

  if (!idCliente || isNaN(idCliente)) {
    return res.status(400).json({ error: 'ID de cliente inválido' });
  }

  const sqlCliente = `
    SELECT 
      id_cli, tipo_usu, nombre_cli, app_cli, apm_cli, correo_cli, edad_cli, sexo_cli, 
      peso_cli, estatura_cli, faf_cli, geb_cli, modo, id_nut, fecha_inicio_pago, fecha_fin_pago, tiene_acceso
    FROM clientes
    WHERE id_cli = ?;
  `;

  const sqlAntecedentes = `
    SELECT 
      id_antecedente, motivo, heredo_familiares, no_patologicos, patologicos, alergias, aversiones, fecha_registro
    FROM antecedentes_medicos
    WHERE id_cli = ?;
  `;

  connection.query(sqlCliente, [idCliente], (err, clienteResults) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error al obtener datos del cliente' });
    }
    if (clienteResults.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    connection.query(sqlAntecedentes, [idCliente], (err2, antecedentesResults) => {
      if (err2) {
        console.error(err2);
        return res.status(500).json({ error: 'Error al obtener antecedentes médicos' });
      }

      const cliente = clienteResults[0];
      cliente.antecedentes_medicos = antecedentesResults;

      res.json(cliente);
    });
  });
});

router.post('/guardar-dieta', async (req, res) => {
  const {
    idCliente,
    nombreDieta,
    objetivoDieta,
    duracion,
    proteinas,
    carbohidratos,
    grasas,
    caloriasObjetivo,
    recomendaciones,
    alimentosPorTiempo // objeto { Desayuno: [...], Colación Matutina: [...], ... }
  } = req.body;

  if (!idCliente || !nombreDieta || !duracion || !proteinas || !carbohidratos || !grasas || !caloriasObjetivo) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }

  // Mapeo frontend -> BD enum
  const nombreTiempoMap = {
    'Desayuno': 'desayuno',
    'Colación Matutina': 'colacion1',
    'Comida': 'comida',
    'Colación Vespertina': 'colacion2',
    'Cena': 'cena'
  };

  const query = (sql, params) => new Promise((resolve, reject) => {
    connection.query(sql, params, (err, results) => {
      if (err) reject(err);
      else resolve(results);
    });
  });

  try {
    // Insertar dieta con activo = 1
    const resultadoDieta = await query(
      `INSERT INTO dietas 
       (id_cli, nombre_dieta, objetivo_dieta, duracion, porcentaje_proteinas, porcentaje_carbs, porcentaje_grasas, calorias_objetivo, recomendaciones, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [idCliente, nombreDieta, objetivoDieta, duracion, proteinas, carbohidratos, grasas, caloriasObjetivo, recomendaciones || null]
    );

    const idDieta = resultadoDieta.insertId;

    // Insertar tiempos y alimentos
    for (const [tiempoFrontend, alimentos] of Object.entries(alimentosPorTiempo)) {
      const nombreTiempoBD = nombreTiempoMap[tiempoFrontend];
      if (!nombreTiempoBD) continue;

      const resultadoTiempo = await query(
        `INSERT INTO tiempos_comida (id_dieta, nombre_tiempo) VALUES (?, ?)`,
        [idDieta, nombreTiempoBD]
      );

      const idTiempo = resultadoTiempo.insertId;

      for (const alimento of alimentos) {
        await query(
          `INSERT INTO alimentos_dieta (id_tiempo, nombre_alimento, cantidad_gramos, calorias, grupo_alimenticio)
           VALUES (?, ?, ?, ?, ?)`,
          [
            idTiempo,
            alimento.nombre || '',
            parseFloat(alimento.cantidad) || 0,
            parseFloat(alimento.calorias) || 0,
            alimento.grupoAlimenticio || 'No definido'
          ]
        );
      }
    }

    // Desactivar todas las demás dietas del cliente menos la que se acaba de insertar
    await query(
      `UPDATE dietas SET activo = 0 WHERE id_cli = ? AND id_dieta != ?`,
      [idCliente, idDieta]
    );

    res.json({ mensaje: 'Dieta guardada correctamente', idDieta });
  } catch (error) {
    console.error('Error al guardar dieta:', error);
    res.status(500).json({ message: 'Error al guardar la dieta', error: error.message });
  }
});




router.get('/info/:id', (req, res) => {
  const idNut = req.params.id;

  if (!idNut) {
    return res.status(400).json({ error: 'Falta id de nutriólogo' });
  }

  const query = `
    SELECT 
      id_nut,
      tipo_usu,
      nombre_nut,
      app_nut,
      apm_nut,
      correo,
      password,
      cedula_nut,
      especialidad_nut,
      telefono_nut,
      token_vinculacion,
      activo,
      fecha_inicio_sub,
      fecha_fin_sub,
      tiene_acceso,
      verificado
    FROM nutriologos
    WHERE id_nut = ?
  `;

  connection.query(query, [idNut], (err, results) => {
    if (err) return res.status(500).json({ error: 'Error en base de datos', detalles: err });
    if (results.length === 0) return res.status(404).json({ error: 'Nutriólogo no encontrado' });

    res.json(results[0]);
  });
});

router.get('/detalle/:id', (req, res) => {
  const idNut = req.params.id;

  if (!idNut) {
    return res.status(400).json({ error: 'Falta id de nutriólogo' });
  }

  connection.query(
    `SELECT 
      id_nut,
      tipo_usu,
      nombre_nut,
      app_nut,
      apm_nut,
      correo,
      cedula_nut,
      especialidad_nut,
      telefono_nut,
      fecha_inicio_sub,
      fecha_fin_sub,
      token_vinculacion,
      tiene_acceso,
      verificado
    FROM nutriologos
    WHERE id_nut = ?`,
    [idNut],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Error en base de datos' });
      if (results.length === 0) return res.status(404).json({ error: 'Nutriólogo no encontrado' });

      const data = results[0];
      res.json(data);
    }
  );
});


// Credenciales PayPal Sandbox
const PAYPAL_CLIENT_ID = 'AbCpAHnHhEs2jlbon0p7sX_hfRcdDE2VN0fYKew2TTddKk2kMQB7JI6C7jl2380cg3Rl2BymYKdlxDxT';
const PAYPAL_SECRET = 'EJ9AM55H8UaXTABTPQoNJcQGdU8y1_cHDTxqVk7xmV8LpyEqkdJGbZLCAteJKVQcj2DbA40bNUK5R4oF';

// Obtener token OAuth de PayPal
async function getPayPalToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');

  const res = await axios.post(
    'https://api-m.sandbox.paypal.com/v1/oauth2/token',
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      }
    }
  );

  return res.data.access_token;
}

// Crear pago y guardar en base de datos
router.post('/crear-pago', async (req, res) => {
  const { id_nut, monto, metodo_pago } = req.body;

  if (!id_nut || !monto || !metodo_pago) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  try {
    const token = await getPayPalToken();

    const ordenResponse = await axios.post(
      'https://api-m.sandbox.paypal.com/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'MXN',
            value: monto.toString()
          }
        }]
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        }
      }
    );

    const orden = ordenResponse.data;
    const fecha_pago = new Date();

    connection.query(
      'INSERT INTO pagos_nutriologos (id_nut, monto, fecha_pago, metodo_pago, estado) VALUES (?, ?, ?, ?, ?)',
      [id_nut, monto, fecha_pago, metodo_pago, 'pendiente'],
      (err, result) => {
        if (err) {
          console.error('Error al guardar pago:', err);
          return res.status(500).json({ error: 'Error al guardar pago en BD' });
        }

        res.json({
          mensaje: 'Pago creado',
          id_pago: result.insertId,
          orden_paypal: orden,
        });
      }
    );
  } catch (error) {
    console.error('Error PayPal:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error con PayPal', detalle: error.message });
  }
});

// Capturar pago y actualizar estado
router.post('/capturar-pago', async (req, res) => {
  const { orderID, id_pago } = req.body;

  if (!orderID || !id_pago) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  try {
    const token = await getPayPalToken();

    const captureResponse = await axios.post(
      `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderID}/capture`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        }
      }
    );

    let estado = 'fallido';
    if (captureResponse.data.status === 'COMPLETED') {
      estado = 'exitoso';
    }

    // Primero actualizamos el estado del pago
    connection.query(
      'UPDATE pagos_nutriologos SET estado = ? WHERE id_pago = ?',
      [estado, id_pago],
      (err) => {
        if (err) {
          console.error('Error al actualizar estado del pago:', err);
          return res.status(500).json({ error: 'Error al actualizar estado del pago' });
        }

        // Si fue exitoso, obtener fecha_pago e id_nut del pago para actualizar nutriologos
        if (estado === 'exitoso') {
          connection.query(
            'SELECT fecha_pago, id_nut FROM pagos_nutriologos WHERE id_pago = ?',
            [id_pago],
            (err, rows) => {
              if (err) {
                console.error('Error al obtener fecha del pago:', err);
                return res.status(500).json({ error: 'Error al obtener fecha del pago' });
              }

              const { fecha_pago, id_nut } = rows[0];

              // Actualiza fecha_inicio_sub = fecha_pago
               connection.query(
        'UPDATE nutriologos SET fecha_inicio_sub = ?, tiene_acceso = 1 WHERE id_nut = ?',
        [fecha_pago, id_nut],
        (err) => {
          if (err) {
            console.error('Error al actualizar suscripción y acceso:', err);
            return res.status(500).json({ error: 'Error al actualizar la suscripción' });
          }

                  res.json({
                    mensaje: 'Pago actualizado y suscripción registrada',
                    estado,
                    detalle: captureResponse.data,
                  });
                }
              );
            }
          );
        } else {
          res.json({
            mensaje: 'Pago actualizado',
            estado,
            detalle: captureResponse.data,
          });
        }
      }
    );
  } catch (error) {
    console.error('Error al capturar pago:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al capturar pago', detalle: error.message });
  }
});

// a) Clientes con dieta activa, calorías promedio y número de comidas en periodo
router.post('/clientes/dietas-activa', (req, res) => {
  const { idNutriologo } = req.body;
  if (!idNutriologo || isNaN(idNutriologo)) {
    return res.status(400).json({ error: 'ID de nutriólogo inválido' });
  }

  const sql = `
    SELECT
      c.id_cli,
      CONCAT(c.nombre_cli, ' ', c.app_cli, ' ', c.apm_cli) AS nombre_completo,
      d.nombre_dieta,
      d.fecha_inicio,
      d.fecha_fin,
      AVG(com.calorias_totales) AS calorias_promedio,
      COUNT(com.id_comida) AS total_comidas
    FROM clientes c
    INNER JOIN dietas d ON c.id_cli = d.id_cli
    LEFT JOIN comidas_registradas com ON c.id_cli = com.id_cli
      AND com.fecha BETWEEN d.fecha_inicio AND d.fecha_fin
    WHERE CURDATE() BETWEEN DATE(d.fecha_inicio) AND DATE(d.fecha_fin)
      AND c.id_nut = ?
    GROUP BY c.id_cli, d.id_dieta
    HAVING total_comidas > 3
    ORDER BY calorias_promedio DESC;
  `;

  connection.query(sql, [idNutriologo], (error, results) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(results);
  });
});

// b) Clientes con dieta activa y días que llevan activos
router.post('/clientes/dias-activos', (req, res) => {
  const { idNutriologo } = req.body;
  if (!idNutriologo || isNaN(idNutriologo)) {
    return res.status(400).json({ error: 'ID de nutriólogo inválido' });
  }

  const sql = `
    SELECT
      c.id_cli,
      CONCAT(c.nombre_cli, ' ', c.app_cli, ' ', c.apm_cli) AS nombre_completo,
      d.nombre_dieta,
      DATEDIFF(
        IF(d.fecha_fin > CURDATE(), CURDATE(), d.fecha_fin),
        d.fecha_inicio
      ) AS dias_actividad
    FROM clientes c
    INNER JOIN dietas d ON c.id_cli = d.id_cli
    WHERE CURDATE() BETWEEN DATE(d.fecha_inicio) AND DATE(d.fecha_fin)
      AND c.id_nut= ?
    ORDER BY dias_actividad DESC;
  `;

  connection.query(sql, [idNutriologo], (error, results) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(results);
  });
});

// c) Clientes con dieta activa que superan su objetivo calórico
router.post('/clientes/superan-objetivo', (req, res) => {
  const { idNutriologo } = req.body;
  if (!idNutriologo || isNaN(idNutriologo)) {
    return res.status(400).json({ error: 'ID de nutriólogo inválido' });
  }

  const sql = `
    SELECT
      c.id_cli,
      CONCAT(c.nombre_cli, ' ', c.app_cli, ' ', c.apm_cli) AS nombre_completo,
      d.calorias_objetivo,
      (
        SELECT AVG(com.calorias_totales)
        FROM comidas_registradas com
        WHERE com.id_cli = c.id_cli
          AND com.fecha BETWEEN d.fecha_inicio AND d.fecha_fin
      ) AS calorias_consumidas
    FROM clientes c
    INNER JOIN dietas d ON c.id_cli = d.id_cli
    WHERE CURDATE() BETWEEN DATE(d.fecha_inicio) AND DATE(d.fecha_fin)
      AND c.id_nut = ?
    HAVING calorias_consumidas > calorias_objetivo
    ORDER BY calorias_consumidas DESC;
  `;

  connection.query(sql, [idNutriologo], (error, results) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(results);
  });
});

// d) Resumen de clientes por sexo y edad
router.post('/clientes/resumen-sexo-modo', (req, res) => {
  const { idNutriologo } = req.body;
  if (!idNutriologo || isNaN(idNutriologo)) {
    return res.status(400).json({ error: 'ID de nutriólogo inválido' });
  }

  const sql = `
    SELECT
      sexo_cli,
      COUNT(id_cli) AS total_clientes,
      AVG(edad_cli) AS edad_promedio
    FROM clientes
    WHERE id_nut = ?
    GROUP BY sexo_cli
    ORDER BY total_clientes DESC;
  `;

  connection.query(sql, [idNutriologo], (error, results) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(results);
  });
});

// Consulta individual (paciente específico) - Info básica
router.post('/cliente/info-basica', (req, res) => {
  const { idCliente, idNutriologo } = req.body;
  if (!idCliente || isNaN(idCliente)) return res.status(400).json({ error: 'ID de cliente inválido' });
  if (!idNutriologo || isNaN(idNutriologo)) return res.status(400).json({ error: 'ID de nutriólogo inválido' });

  const sql = `
    SELECT
      c.id_cli,
      CONCAT(c.nombre_cli, ' ', c.app_cli, ' ', c.apm_cli) AS nombre_completo,
      c.edad_cli,
      d.nombre_dieta,
      d.objetivo_dieta,
      d.fecha_inicio,
      d.fecha_fin,
      DATEDIFF(
        IF(d.fecha_fin > CURDATE(), CURDATE(), d.fecha_fin),
        d.fecha_inicio
      ) AS dias_actividad
    FROM clientes c
    LEFT JOIN dietas d ON c.id_cli = d.id_cli
    WHERE c.id_cli = ?
      AND c.id_nut = ?
      AND CURDATE() BETWEEN DATE(d.fecha_inicio) AND DATE(d.fecha_fin);
  `;

  connection.query(sql, [idCliente, idNutriologo], (error, results) => {
    if (error) return res.status(500).json({ error: error.message });
    if (results.length === 0) return res.status(404).json({ error: 'Cliente no encontrado o sin dieta activa' });
    res.json(results[0]);
  });
});

// Datos de calorías diarias (promedio) para paciente individual en periodo
router.post('/cliente/calorias', (req, res) => {
  const { idCliente, idNutriologo } = req.body;
  if (!idCliente || isNaN(idCliente)) return res.status(400).json({ error: 'ID de cliente inválido' });
  if (!idNutriologo || isNaN(idNutriologo)) return res.status(400).json({ error: 'ID de nutriólogo inválido' });

  const sql = `
    SELECT
      DATE(com.fecha) AS dia,
      AVG(com.calorias_totales) AS calorias
    FROM comidas_registradas com
    INNER JOIN dietas d ON com.id_cli = d.id_cli
    INNER JOIN clientes c ON com.id_cli = c.id_cli
    WHERE com.id_cli = ?
      AND c.id_nut = ?
      AND com.fecha BETWEEN d.fecha_inicio AND d.fecha_fin
    GROUP BY DATE(com.fecha)
    ORDER BY dia ASC;
  `;

  connection.query(sql, [idCliente, idNutriologo], (error, results) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(results);
  });
});

// Macronutrientes consumidos para paciente individual
router.post('/cliente/macronutrientes', (req, res) => {
  const { idCliente, idNutriologo } = req.body;
  if (!idCliente || isNaN(idCliente)) return res.status(400).json({ error: 'ID de cliente inválido' });
  if (!idNutriologo || isNaN(idNutriologo)) return res.status(400).json({ error: 'ID de nutriólogo inválido' });

  const sql = `
    SELECT
      'Proteínas' AS name, AVG(com.proteinas) AS value
    FROM comidas_registradas com
    INNER JOIN dietas d ON com.id_cli = d.id_cli
    INNER JOIN clientes c ON com.id_cli = c.id_cli
    WHERE com.id_cli = ?
      AND c.id_nut = ?
      AND com.fecha BETWEEN d.fecha_inicio AND d.fecha_fin
    UNION ALL
    SELECT
      'Carbohidratos', AVG(com.carbohidratos)
    FROM comidas_registradas com
    INNER JOIN dietas d ON com.id_cli = d.id_cli
    INNER JOIN clientes c ON com.id_cli = c.id_cli
    WHERE com.id_cli = ?
      AND c.id_nut = ?
      AND com.fecha BETWEEN d.fecha_inicio AND d.fecha_fin
    UNION ALL
    SELECT
      'Grasas', AVG(com.grasas)
    FROM comidas_registradas com
    INNER JOIN dietas d ON com.id_cli = d.id_cli
    INNER JOIN clientes c ON com.id_cli = c.id_cli
    WHERE com.id_cli = ?
      AND c.id_nut = ?
      AND com.fecha BETWEEN d.fecha_inicio AND d.fecha_fin;
  `;

  connection.query(sql, [idCliente, idNutriologo, idCliente, idNutriologo, idCliente, idNutriologo], (error, results) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(results);
  });
});

// Adherencia a la dieta
router.post('/cliente/adherencia', (req, res) => {
  const { idCliente, idNutriologo } = req.body;
  if (!idCliente || isNaN(idCliente)) return res.status(400).json({ error: 'ID de cliente inválido' });
  if (!idNutriologo || isNaN(idNutriologo)) return res.status(400).json({ error: 'ID de nutriólogo inválido' });

  const sql = `
    SELECT
      DATE(com.fecha) AS dia,
      100 AS porcentaje
    FROM comidas_registradas com
    INNER JOIN clientes c ON com.id_cli = c.id_cli
    WHERE com.id_cli = ?
      AND c.id_nut= ?
    GROUP BY DATE(com.fecha)
    ORDER BY dia ASC;
  `;

  connection.query(sql, [idCliente, idNutriologo], (error, results) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(results);
  });
});

// Cumplimiento de horarios
router.post('/cliente/horarios', (req, res) => {
  const { idCliente, idNutriologo } = req.body;
  if (!idCliente || isNaN(idCliente)) return res.status(400).json({ error: 'ID de cliente inválido' });
  if (!idNutriologo || isNaN(idNutriologo)) return res.status(400).json({ error: 'ID de nutriólogo inválido' });

  const sql = `
    SELECT
      com.tipo_comida AS comida,
      AVG(CASE WHEN com.cumplido = 1 THEN 1 ELSE 0 END)*100 AS cumplido
    FROM comidas_registradas com
    INNER JOIN clientes c ON com.id_cli = c.id_cli
    WHERE com.id_cli = ?
      AND c.id_nut = ?
    GROUP BY com.tipo_comida;
  `;

  connection.query(sql, [idCliente, idNutriologo], (error, results) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(results);
  });
});




module.exports = router;  
