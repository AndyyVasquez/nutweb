require('dotenv').config();
const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const Buffer = require('buffer').Buffer;

// Configuración de base de datos desde variables de entorno
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
};

app.use(cors({
  origin: [
    '*'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true
}));

app.use(express.json());
// Pool de conexiones MySQL
const pool = mysql.createPool(dbConfig);

// Función para conectar a MongoDB (se importará desde server.js)
let connectToMongo;

// Función para inicializar la conexión MongoDB
const initMongoDB = (mongoConnection) => {
  connectToMongo = mongoConnection;
};

// Obtener pasos por usuario
router.get('/pasos/:id_cli', async (req, res) => {
  const { id_cli } = req.params;

  try {
    const db = await connectToMongo();
    const pasos = await db
      .collection('pasos')
      .find({ id_cli: parseInt(id_cli) })
      .sort({ fecha: 1 }) // Opcional: ordenar por fecha ascendente
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

  const query = `
    SELECT 
      d.id_dieta,
      d.nombre_dieta,
      d.objetivo_dieta,
      d.duracion,
      d.calorias_objetivo,
      d.porcentaje_proteinas,
      d.porcentaje_carbs,
      d.porcentaje_grasas,
      d.fecha_inicio,
      d.fecha_fin,
      d.recomendaciones
    FROM dietas d
    WHERE d.id_cli = ?
  `;

  try {
    const [results] = await pool.execute(query, [idCliente]);
    res.json(results);
  } catch (err) {
    console.error('Error al obtener dietas por cliente:', err);
    res.status(500).json({ error: 'Error al obtener las dietas del cliente' });
  }
});

// Verificar nutriólogo
router.put('/nutriologos/:id/verificar', async (req, res) => {
  const id = req.params.id;
  const fechaHoy = new Date().toISOString().split('T')[0]; // formato 'YYYY-MM-DD'

  const sql = `
    UPDATE nutriologos
    SET verificado = ?,
        fecha_inicio_sub = IF(fecha_inicio_sub IS NULL, ?, fecha_inicio_sub),
        tiene_acceso = 1
    WHERE id_nut = ?
  `;

  try {
    const [result] = await pool.execute(sql, ['aprobado', fechaHoy, id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Nutriólogo no encontrado' });
    }

    return res.json({ message: 'Nutriólogo aprobado correctamente' });
  } catch (error) {
    console.error('Error al actualizar verificado:', error);
    return res.status(500).json({ message: 'Error del servidor' });
  }
});

// Denegar nutriólogo
router.put('/nutriologos/:id/denegar', async (req, res) => {
  const id = req.params.id;

  const sql = `
    UPDATE nutriologos
    SET verificado = 'denegado',
        tiene_acceso = 0
    WHERE id_nut = ?
  `;

  try {
    const [result] = await pool.execute(sql, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Nutriólogo no encontrado' });
    }

    return res.json({ message: 'Nutriólogo rechazado correctamente' });
  } catch (error) {
    console.error('Error al denegar nutriólogo:', error);
    return res.status(500).json({ message: 'Error del servidor' });
  }
});

// Ruta para obtener todos los nutriólogos
router.get('/nutriologos', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM nutriologos');
    res.json(rows);
  } catch (error) {
    console.error('Error en /nutriologos:', error);
    return res.status(500).json({ message: 'Error en el servidor' });
  }
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

    const [result] = await pool.execute(sql, [
      nombre_nut,
      app_nut,
      apm_nut,
      correo,
      hashedPassword,
      cedula_nut,
      especialidad_nut,
      telefono_nut,
      token_vinculacion,
    ]);

    res.status(201).json({ message: 'Nutriólogo registrado exitosamente' });
  } catch (error) {
    console.error('Error en el registro:', error);
    res.status(500).json({ error: 'Correo o token ya registrados' });
  }
});

// LOGIN - nutriólogos o administradores 
router.post('/nutriologos/login', async (req, res) => {
  const { correo, password } = req.body;

  const sqlNutri = `SELECT id_nut AS id, nombre_nut AS nombre, password, token, verificado, tiene_acceso, tipo_usu, 'nutriologo' AS rol FROM nutriologos WHERE correo = ?`;

  try {
    const [results] = await pool.execute(sqlNutri, [correo]);

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
      await pool.execute(
        `UPDATE nutriologos SET token = ? WHERE id_nut = ?`,
        [newToken, nutri.id]
      );

      res.json({
        message: 'Inicio de sesión exitoso (nutriólogo)',
        id_nut: nutri.id,
        nombre: nutri.nombre,
        token: newToken,
        tipo_usu: nutri.tipo_usu,
        rol: 'nutriologo'
      });
    } else {
      const sqlAdmin = `SELECT id_admin AS id, nombre_admin AS nombre, password, token, tipo_usu, 'admin' AS rol FROM administradores WHERE correo = ?`;

      const [resultsAdmin] = await pool.execute(sqlAdmin, [correo]);

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
      await pool.execute(
        `UPDATE administradores SET token = ? WHERE id_admin = ?`,
        [newToken, admin.id]
      );

      res.json({
        message: 'Inicio de sesión exitoso (administrador)',
        id_nut: admin.id, // para mantener la clave en frontend
        nombre: admin.nombre,
        token: newToken,
        tipo_usu: admin.tipo_usu,
        rol: 'admin'
      });
    }
  } catch (err) {
    console.error('Error en login:', err);
    return res.status(500).json({ error: 'Error en el servidor' });
  }
});

// LOGOUT 
router.post('/nutriologos/logout', async (req, res) => {
  const { id, rol } = req.body;

  // Validación de datos
  if (!id || !rol) {
    return res.status(400).json({ error: 'Datos incompletos para cerrar sesión' });
  }

  // Determinar tabla y campo según el rol
  const tabla = rol === 'admin' ? 'administradores' : 'nutriologos';
  const campo = rol === 'admin' ? 'id_admin' : 'id_nut';

  try {
    const [result] = await pool.execute(
      `UPDATE ${tabla} SET token = NULL WHERE ${campo} = ?`,
      [id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    res.json({ message: 'Sesión cerrada correctamente' });
  } catch (err) {
    console.error('Error en la base de datos:', err);
    return res.status(500).json({ error: 'Error al cerrar sesión' });
  }
});

// Login con Google
router.post('/nutriologos/login-google', async (req, res) => {
  const { correo, nombre } = req.body;
  if (!correo) return res.status(400).json({ error: 'Correo requerido' });

  const sqlNutri = `SELECT id_nut AS id, nombre_nut AS nombre, token, verificado, tiene_acceso, tipo_usu FROM nutriologos WHERE correo = ?`;

  try {
    const [results] = await pool.execute(sqlNutri, [correo]);

    if (results.length > 0) {
      const nutri = results[0];

      if (nutri.verificado === 'denegado') {
        return res.status(403).json({ error: 'Solicitud de registro aún no aprobada.' });
      }

      if (nutri.tiene_acceso === 0) {
        return res.status(403).json({ error: 'No tienes acceso en este momento' });
      }

      const newToken = uuidv4();
      await pool.execute(`UPDATE nutriologos SET token = ? WHERE id_nut = ?`, [newToken, nutri.id]);

      res.json({
        message: 'Inicio de sesión exitoso (nutriólogo)',
        id_nut: nutri.id,
        nombre: nutri.nombre,
        token: newToken,
        tipo_usu: nutri.tipo_usu,
        rol: 'nutriologo',
      });
    } else {
      res.status(404).json({ error: 'Usuario no registrado, favor registrarse' });
    }
  } catch (err) {
    console.error('Error en login Google:', err);
    return res.status(500).json({ error: 'Error en el servidor' });
  }
});

// Middleware para verificar token de sesión
const verifyToken = async (req, res, next) => {
  const id_nut = req.headers['id_nut'];
  const token = req.headers['token'];
  const rol = req.headers['rol'];

  if (!id_nut || !token || !rol) {
    return res.status(401).json({ error: 'Faltan credenciales de autenticación' });
  }

  const tabla = rol === 'admin' ? 'administradores' : 'nutriologos';
  const campo = rol === 'admin' ? 'id_admin' : 'id_nut';

  const sql = `SELECT token FROM ${tabla} WHERE ${campo} = ?`;

  try {
    const [results] = await pool.execute(sql, [id_nut]);

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
  } catch (err) {
    console.error('Error verificando token:', err);
    return res.status(500).json({ error: 'Error en la base de datos' });
  }
};

// objetivo de dieta activa
router.get('/cliente-objetivo/:id', async (req, res) => {
  const clienteId = req.params.id;

  console.log('Cliente ID recibido:', clienteId);

  if (!clienteId || isNaN(clienteId)) {
    return res.status(400).json({ message: 'ID inválido' });
  }

  const query = `
    SELECT objetivo_dieta 
    FROM dietas 
    WHERE id_cli = ? AND activo = 1 
    LIMIT 1
  `;

  try {
    const [results] = await pool.execute(query, [clienteId]);

    if (results.length > 0) {
      res.json({ objetivo_dieta: results[0].objetivo_dieta });
    } else {
      res.status(404).json({ message: 'No se encontró objetivo para este cliente' });
    }
  } catch (err) {
    console.error('Error al ejecutar la consulta:', err);
    return res.status(500).json({ message: 'Error en el servidor' });
  }
});

// Obtener clientes por nutriólogo
router.post('/clientes-por-nutriologo', async (req, res) => {
  const { idNutriologo } = req.body;

  if (!idNutriologo || isNaN(idNutriologo)) {
    return res.status(400).json({ error: 'ID de nutriólogo inválido' });
  }

  const query = `
    SELECT 
      c.*, 
      f.motivo, 
      f.antecedentes_heredofamiliares, 
      f.antecedentes_personales_no_patologicos, 
      f.antecedentes_personales_patologicos, 
      f.alergias_intolerancias, 
      f.aversiones_alimentarias,
      f.fecha_envio AS fecha_registro_antecedentes
    FROM 
      clientes c
    LEFT JOIN 
      formularios_nutricion f ON c.id_cli = f.id_cliente
    WHERE 
      c.id_nut = ?
    ORDER BY 
      c.id_cli, f.fecha_envio DESC
  `;

  try {
    const [clientes] = await pool.execute(query, [idNutriologo]);

    // Agrupar los antecedentes médicos por cliente
    const clientesAgrupados = clientes.reduce((acc, row) => {
      if (!acc[row.id_cli]) {
        acc[row.id_cli] = {
          ...row,
          antecedentes: []
        };
        // Eliminar los campos de formulario para evitar repetición
        delete acc[row.id_cli].motivo;
        delete acc[row.id_cli].antecedentes_heredofamiliares;
        delete acc[row.id_cli].antecedentes_personales_no_patologicos;
        delete acc[row.id_cli].antecedentes_personales_patologicos;
        delete acc[row.id_cli].alergias_intolerancias;
        delete acc[row.id_cli].aversiones_alimentarias;
        delete acc[row.id_cli].fecha_registro_antecedentes;
      }

      if (row.motivo) {
        acc[row.id_cli].antecedentes.push({
          motivo: row.motivo,
          heredo_familiares: row.antecedentes_heredofamiliares,
          no_patologicos: row.antecedentes_personales_no_patologicos,
          patologicos: row.antecedentes_personales_patologicos,
          alergias: row.alergias_intolerancias,
          aversiones: row.aversiones_alimentarias,
          fecha_registro: row.fecha_registro_antecedentes
        });
      }

      return acc;
    }, {});

    res.json(Object.values(clientesAgrupados));
  } catch (err) {
    console.error('Error al obtener clientes:', err);
    return res.status(500).json({ error: 'Error en la base de datos' });
  }
});

// Detalle de cliente
router.post('/cliente-detalle', async (req, res) => {
  const { idCliente } = req.body;

  if (!idCliente || isNaN(idCliente)) {
    return res.status(400).json({ error: 'ID de cliente inválido' });
  }

  const sqlCliente = `
    SELECT 
      id_cli, tipo_usu, nombre_cli, app_cli, apm_cli, correo_cli, edad_cli, sexo_cli, 
      peso_cli, estatura_cli, faf_cli, geb_cli, modo, id_nut, fecha_inicio_pago, fecha_fin_pago, tiene_acceso
    FROM clientes
    WHERE id_cli = ?
  `;

  const sqlAntecedentes = `
    SELECT 
      id AS id_formulario,
      motivo, 
      antecedentes_heredofamiliares, 
      antecedentes_personales_no_patologicos, 
      antecedentes_personales_patologicos, 
      alergias_intolerancias, 
      aversiones_alimentarias, 
      fecha_envio AS fecha_registro
    FROM formularios_nutricion
    WHERE id_cliente = ?
    ORDER BY fecha_envio DESC
  `;

  try {
    const [clienteResults] = await pool.execute(sqlCliente, [idCliente]);
    
    if (clienteResults.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const [antecedentesResults] = await pool.execute(sqlAntecedentes, [idCliente]);

    const cliente = clienteResults[0];
    cliente.antecedentes_nutricionales = antecedentesResults;

    res.json(cliente);
  } catch (err) {
    console.error('Error al obtener datos del cliente:', err);
    return res.status(500).json({ error: 'Error al obtener datos del cliente' });
  }
});

// Guardar dieta
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

  const connection = await mysql.createConnection(dbConfig);

  try {
    await connection.beginTransaction();

    // Insertar dieta con activo = 1
    const [resultadoDieta] = await connection.execute(
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

      const [resultadoTiempo] = await connection.execute(
        `INSERT INTO tiempos_comida (id_dieta, nombre_tiempo) VALUES (?, ?)`,
        [idDieta, nombreTiempoBD]
      );

      const idTiempo = resultadoTiempo.insertId;

      for (const alimento of alimentos) {
        await connection.execute(
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
    await connection.execute(
      `UPDATE dietas SET activo = 0 WHERE id_cli = ? AND id_dieta != ?`,
      [idCliente, idDieta]
    );

    await connection.commit();
    res.json({ mensaje: 'Dieta guardada correctamente', idDieta });
  } catch (error) {
    await connection.rollback();
    console.error('Error al guardar dieta:', error);
    res.status(500).json({ message: 'Error al guardar la dieta', error: error.message });
  } finally {
    await connection.end();
  }
});

// Obtener información del nutriólogo
router.get('/info/:id', async (req, res) => {
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

  try {
    const [results] = await pool.execute(query, [idNut]);
    
    if (results.length === 0) {
      return res.status(404).json({ error: 'Nutriólogo no encontrado' });
    }

    res.json(results[0]);
  } catch (err) {
    console.error('Error obteniendo info nutriólogo:', err);
    return res.status(500).json({ error: 'Error en base de datos', detalles: err });
  }
});

// Detalle del nutriólogo
router.get('/detalle/:id', async (req, res) => {
  const idNut = req.params.id;

  if (!idNut) {
    return res.status(400).json({ error: 'Falta id de nutriólogo' });
  }

  try {
    const [results] = await pool.execute(
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
      [idNut]
    );
    
    if (results.length === 0) {
      return res.status(404).json({ error: 'Nutriólogo no encontrado' });
    }

    res.json(results[0]);
  } catch (err) {
    console.error('Error obteniendo detalle nutriólogo:', err);
    return res.status(500).json({ error: 'Error en base de datos' });
  }
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

    const [result] = await pool.execute(
      'INSERT INTO pagos_nutriologos (id_nut, monto, fecha_pago, metodo_pago, estado) VALUES (?, ?, ?, ?, ?)',
      [id_nut, monto, fecha_pago, metodo_pago, 'pendiente']
    );

    res.json({
      mensaje: 'Pago creado',
      id_pago: result.insertId,
      orden_paypal: orden,
    });
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
    const [updateResult] = await pool.execute(
      'UPDATE pagos_nutriologos SET estado = ? WHERE id_pago = ?',
      [estado, id_pago]
    );

    // Si fue exitoso, obtener fecha_pago e id_nut del pago para actualizar nutriologos
    if (estado === 'exitoso') {
      const [rows] = await pool.execute(
        'SELECT fecha_pago, id_nut FROM pagos_nutriologos WHERE id_pago = ?',
        [id_pago]
      );

      const { fecha_pago, id_nut } = rows[0];

      // Actualiza fecha_inicio_sub = fecha_pago
      await pool.execute(
        'UPDATE nutriologos SET fecha_inicio_sub = ?, tiene_acceso = 1 WHERE id_nut = ?',
        [fecha_pago, id_nut]
      );

      res.json({
        mensaje: 'Pago actualizado y suscripción registrada',
        estado,
        detalle: captureResponse.data,
      });
    } else {
      res.json({
        mensaje: 'Pago actualizado',
        estado,
        detalle: captureResponse.data,
      });
    }
  } catch (error) {
    console.error('Error al capturar pago:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al capturar pago', detalle: error.message });
  }
});

// === ESTADÍSTICAS Y REPORTES ===

// a) Clientes con dieta activa, calorías promedio y número de comidas en periodo
router.post('/clientes/dietas-activa', async (req, res) => {
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

  try {
    const [results] = await pool.execute(sql, [idNutriologo]);
    res.json(results);
  } catch (error) {
    console.error('Error en estadísticas dietas activas:', error);
    return res.status(500).json({ error: error.message });
  }
});

// b) Clientes con dieta activa y días que llevan activos
router.post('/clientes/dias-activos', async (req, res) => {
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

  try {
    const [results] = await pool.execute(sql, [idNutriologo]);
    res.json(results);
  } catch (error) {
    console.error('Error en estadísticas días activos:', error);
    return res.status(500).json({ error: error.message });
  }
});

// c) Clientes con dieta activa que superan su objetivo calórico
router.post('/clientes/superan-objetivo', async (req, res) => {
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

  try {
    const [results] = await pool.execute(sql, [idNutriologo]);
    res.json(results);
  } catch (error) {
    console.error('Error en estadísticas objetivo superado:', error);
    return res.status(500).json({ error: error.message });
  }
});

// d) Resumen de clientes por sexo y edad
router.post('/clientes/resumen-sexo-modo', async (req, res) => {
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

  try {
    const [results] = await pool.execute(sql, [idNutriologo]);
    res.json(results);
  } catch (error) {
    console.error('Error en resumen por sexo:', error);
    return res.status(500).json({ error: error.message });
  }
});

// === ESTADÍSTICAS INDIVIDUALES POR CLIENTE ===

// Consulta individual (paciente específico) - Info básica
router.post('/cliente/info-basica', async (req, res) => {
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

  try {
    const [results] = await pool.execute(sql, [idCliente, idNutriologo]);
    
    if (results.length === 0) {
      return res.status(404).json({ error: 'Cliente no encontrado o sin dieta activa' });
    }
    
    res.json(results[0]);
  } catch (error) {
    console.error('Error en info básica cliente:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Datos de calorías diarias (promedio) para paciente individual en periodo
router.post('/cliente/calorias', async (req, res) => {
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

  try {
    const [results] = await pool.execute(sql, [idCliente, idNutriologo]);
    res.json(results);
  } catch (error) {
    console.error('Error en calorías cliente:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Macronutrientes consumidos para paciente individual
router.post('/cliente/macronutrientes', async (req, res) => {
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

  try {
    const [results] = await pool.execute(sql, [idCliente, idNutriologo, idCliente, idNutriologo, idCliente, idNutriologo]);
    res.json(results);
  } catch (error) {
    console.error('Error en macronutrientes cliente:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Adherencia a la dieta
router.post('/cliente/adherencia', async (req, res) => {
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

  try {
    const [results] = await pool.execute(sql, [idCliente, idNutriologo]);
    res.json(results);
  } catch (error) {
    console.error('Error en adherencia cliente:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Cumplimiento de horarios
router.post('/cliente/horarios', async (req, res) => {
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

  try {
    const [results] = await pool.execute(sql, [idCliente, idNutriologo]);
    res.json(results);
  } catch (error) {
    console.error('Error en horarios cliente:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Exportar el router y la función de inicialización de MongoDB
module.exports = { router, initMongoDB };