require('dotenv').config();

const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const Buffer = require('buffer').Buffer;

const app = express();

// Configuración de CORS
app.use(cors({
  origin: [
    '*'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'id_nut', 'token', 'rol'],
  credentials: true
}));

app.use(express.json());

// Middleware de logging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  console.log('Raw body:', req.body);
  next();
});

// Configuración de base de datos MySQL desde .env
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
};

// Pool de conexiones MySQL
const pool = mysql.createPool(dbConfig);

// Variable para conexión MySQL simple (para compatibilidad con código web)
let connection = {
  query: (sql, params, callback) => {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    pool.execute(sql, params)
      .then(([rows, fields]) => {
        callback(null, rows);
      })
      .catch(err => callback(err));
  }
};

// Estado global de podómetros conectados
let connectedPedometers = new Map();

// =============================================================================
// CONFIGURACIÓN MERCADO PAGO (MÓVIL)
// =============================================================================
const mercadopago = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN_SANDBOX || 'TEST-3273803796754942-071504-bb24735cf345727f37edd8cf177909da-398459562',
  options: {
    timeout: 5000,
    idempotencyKey: 'abc123'
  }
});

const payment = new Payment(mercadopago);
const preference = new Preference(mercadopago);

// =============================================================================
// CONFIGURACIÓN PAYPAL (WEB)
// =============================================================================
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || 'AbCpAHnHhEs2jlbon0p7sX_hfRcdDE2VN0fYKew2TTddKk2kMQB7JI6C7jl2380cg3Rl2BymYKdlxDxT';
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || 'EJ9AM55H8UaXTABTPQoNJcQGdU8y1_cHDTxqVk7xmV8LpyEqkdJGbZLCAteJKVQcj2DbA40bNUK5R4oF';

// Estado de la báscula
let scaleState = {
  connected: false,
  weight: 0,
  lastUpdate: null,
  calibrated: true
};

// Estado del podómetro ESP32
let pedometerState = {
  connected: false,
  steps: 0,
  isCountingSteps: false,
  lastUpdate: null,
  dailyGoal: 10000,
  deviceName: 'PodometroESP32',
  batteryLevel: 100
};

// Configuración MongoDB Atlas desde .env
const mongoUrl = process.env.MONGO_URI;
const mongoDbName = process.env.MONGO_DB;

// Cliente MongoDB
let mongoClient;
let mongoDB = null;

// Conectar MongoDB
async function connectMongo() {
  try {
    console.log("🔄 Conectando a MongoDB...");
    console.log("URI:", process.env.MONGO_URI?.substring(0, 30) + "...");
    console.log("DB Name:", process.env.MONGO_DB);
    
    const mongoClient = new MongoClient(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    await mongoClient.connect();
    console.log("✅ Cliente MongoDB conectado");
    
    mongoDB = mongoClient.db(process.env.MONGO_DB);
    console.log("✅ Base de datos seleccionada:", mongoDB.databaseName);

    // Ping para verificar conexión
    await mongoClient.db("admin").command({ ping: 1 });
    console.log("✅ Ping exitoso a MongoDB");

    // Listar colecciones
    const colecciones = await mongoDB.listCollections().toArray();
    console.log("📂 Colecciones encontradas:", colecciones.map(c => c.name));

  } catch (err) {
    console.error('❌ Error conectando a MongoDB:', err);
  }
}
connectMongo();

async function getMongoConnection() {
  if (!mongoDB) {
    await connectMongo();
  }
  return mongoDB;
}

// =============================================================================
// WEBSOCKET PARA IOT
// =============================================================================
const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (ws) => {
  console.log('📟 Nueva conexión WebSocket establecida');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // === BÁSCULA ===
      if (data.type === 'scale_connect') {
        scaleState.connected = true;
        scaleState.lastUpdate = new Date();
        console.log('📟 Báscula conectada');
        
        ws.send(JSON.stringify({
          type: 'connection_confirmed',
          device: 'scale',
          timestamp: new Date().toISOString()
        }));
      }
      
      if (data.type === 'weight_update') {
        scaleState.weight = data.weight;
        scaleState.lastUpdate = new Date();
        console.log('⚖️ Peso actualizado:', data.weight, 'g');
      }

      if (data.type === 'weighing_complete') {
        scaleState.weight = data.weight;
        scaleState.lastUpdate = new Date();
        console.log('✅ Pesado completado:', data.weight, 'g');
      }
      
      // === PODÓMETRO ESP32 ===
      if (data.type === 'pedometer_connect') {
        pedometerState.connected = true;
        pedometerState.lastUpdate = new Date();
        console.log('👟 Podómetro ESP32 conectado');
        
        ws.send(JSON.stringify({
          type: 'connection_confirmed',
          device: 'pedometer',
          timestamp: new Date().toISOString()
        }));
      }
      
      if (data.type === 'steps_update') {
        pedometerState.steps = data.steps || 0;
        pedometerState.lastUpdate = new Date();
        console.log('👟 Pasos actualizados:', data.steps);
        
        // Guardar pasos en base de datos
        saveStepsToDatabase(data.steps, data.userId || null);
      }
      
      if (data.type === 'counting_status') {
        pedometerState.isCountingSteps = data.counting || false;
        console.log('👟 Estado conteo:', data.counting ? 'Iniciado' : 'Detenido');
      }
      
      if (data.type === 'battery_update') {
        pedometerState.batteryLevel = data.batteryLevel || 100;
        console.log('🔋 Batería ESP32:', data.batteryLevel + '%');
      }
      
    } catch (error) {
      console.error('❌ Error procesando mensaje WebSocket:', error);
    }
  });
  
  ws.on('close', () => {
    scaleState.connected = false;
    pedometerState.connected = false;
    console.log('📟 Dispositivo IoT desconectado');
  });
});

// =============================================================================
// FUNCIONES AUXILIARES
// =============================================================================

// Función para guardar pasos en base de datos
// Función para guardar pasos en base de datos
const saveStepsToDatabase = async (steps, userId = null) => {
  try {
    if (!userId) {
      console.log('⚠️ No se especificó usuario para guardar pasos');
      return;
    }
    
    const today = new Date().toISOString().split('T')[0];
    const hora = new Date().toTimeString().split(' ')[0];
    
    // === GUARDAR EN MYSQL ===
    const checkQuery = `
      SELECT id_actividad FROM actividad_fisica 
      WHERE id_cli = ? AND fecha = ? AND tipo_actividad = 'pasos'
    `;
    
    const [existingRows] = await pool.execute(checkQuery, [userId, today]);
    
    if (existingRows.length > 0) {
      const updateQuery = `
        UPDATE actividad_fisica 
        SET pasos_totales = ?, hora_actualizacion = ?, last_update = NOW()
        WHERE id_cli = ? AND fecha = ? AND tipo_actividad = 'pasos'
      `;
      
      await pool.execute(updateQuery, [steps, hora, userId, today]);
      console.log(`👟 Pasos actualizados en MySQL: ${steps} para usuario ${userId}`);
    } else {
      const insertQuery = `
        INSERT INTO actividad_fisica 
        (id_cli, fecha, hora_actualizacion, tipo_actividad, pasos_totales, calorias_quemadas, last_update) 
        VALUES (?, ?, ?, 'pasos', ?, ?, NOW())
      `;
      
      const caloriasEstimadas = Math.round(steps * 0.04);
      await pool.execute(insertQuery, [userId, today, hora, steps, caloriasEstimadas]);
      console.log(`👟 Nuevo registro de pasos en MySQL: ${steps} para usuario ${userId}`);
    }

    // === GUARDAR EN MONGODB ===
    if (mongoDB) {
      try {
        const collection = mongoDB.collection('actividad_pasos');
        
        const existingDoc = await collection.findOne({
          id_cli: parseInt(userId),
          fecha: today
        });

        const caloriasGastadas = Math.round(steps * 0.04);
        const distanciaKm = (steps * 0.75 / 1000).toFixed(2);
        
        const documentoMongo = {
          id_cli: parseInt(userId),
          fecha: today,
          pasos: steps,
          calorias_gastadas: caloriasGastadas,
          distancia_km: parseFloat(distanciaKm),
          hora_ultima_actualizacion: hora,
          timestamp: new Date(),
          dispositivo: 'ESP32',
          estado: 'activo'
        };

        if (existingDoc) {
          await collection.updateOne(
            { _id: existingDoc._id },
            { 
              $set: {
                pasos: steps,
                calorias_gastadas: caloriasGastadas,
                distancia_km: parseFloat(distanciaKm),
                hora_ultima_actualizacion: hora,
                timestamp: new Date()
              }
            }
          );
          console.log(`👟 Pasos actualizados en MongoDB: ${steps} para usuario ${userId}`);
        } else {
          const result = await collection.insertOne(documentoMongo);
          console.log(`👟 Nuevo registro de pasos en MongoDB: ${steps}, ID: ${result.insertedId}`);
        }

      } catch (mongoError) {
        console.error('❌ Error guardando en MongoDB:', mongoError);
      }
    }
    
  } catch (error) {
    console.error('❌ Error al guardar pasos en base de datos:', error);
  }
};
// =============================================================================
// ENDPOINTS WEB - NUTRIÓLOGOS
// =============================================================================

// Obtener todos los nutriólogos
app.get('/api/nutriologos', (req, res) => {
  connection.query('SELECT * FROM nutriologos', (error, rows) => {
    if (error) {
      console.error('Error en /nutriologos:', error);
      return res.status(500).json({ message: 'Error en el servidor' });
    }
    res.json(rows);
  });
});

// Verificar nutriólogo
app.put('/api/nutriologos/:id/verificar', (req, res) => {
  const id = req.params.id;
  const fechaHoy = new Date().toISOString().split('T')[0];

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

// Denegar nutriólogo
app.put('/api/nutriologos/:id/denegar', (req, res) => {
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

// Obtener información del nutriólogo
app.get('/api/info/:id', (req, res) => {
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

// Obtener detalle del nutriólogo
app.get('/api/detalle/:id', (req, res) => {
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

// =============================================================================
// ENDPOINTS WEB - CLIENTES Y DIETAS
// =============================================================================

// Obtener objetivo de dieta activa
app.get('/api/cliente-objetivo/:id', (req, res) => {
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

  connection.query(query, [clienteId], (err, results) => {
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

// Obtener clientes por nutriólogo
app.post('/api/clientes-por-nutriologo', (req, res) => {
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

  connection.query(query, [idNutriologo], (err, clientes) => {
    if (err) {
      console.error('Error al obtener clientes:', err);
      return res.status(500).json({ error: 'Error en la base de datos' });
    }

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

// Obtener cliente por ID
app.post('/api/cliente-detalle', (req, res) => {
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

// Guardar dieta
app.post('/api/guardar-dieta', async (req, res) => {
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
    alimentosPorTiempo
  } = req.body;

  if (!idCliente || !nombreDieta || !duracion || !proteinas || !carbohidratos || !grasas || !caloriasObjetivo) {
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }

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
    const resultadoDieta = await query(
      `INSERT INTO dietas 
       (id_cli, nombre_dieta, objetivo_dieta, duracion, porcentaje_proteinas, porcentaje_carbs, porcentaje_grasas, calorias_objetivo, recomendaciones, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [idCliente, nombreDieta, objetivoDieta, duracion, proteinas, carbohidratos, grasas, caloriasObjetivo, recomendaciones || null]
    );

    const idDieta = resultadoDieta.insertId;

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

// =============================================================================
// ENDPOINTS ANALYTICS - WEB
// =============================================================================

// Clientes con dieta activa
app.post('/api/clientes/dietas-activa', (req, res) => {
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

// Clientes con días activos
app.post('/api/clientes/dias-activos', (req, res) => {
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

// Clientes que superan objetivo
app.post('/api/clientes/superan-objetivo', (req, res) => {
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

// Resumen por sexo
app.post('/api/clientes/resumen-sexo-modo', (req, res) => {
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

// Info básica de cliente
app.post('/api/cliente/info-basica', (req, res) => {
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

// Calorías por cliente
app.post('/api/cliente/calorias', (req, res) => {
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

// Macronutrientes por cliente
app.post('/api/cliente/macronutrientes', (req, res) => {
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

// Adherencia por cliente
app.post('/api/cliente/adherencia', (req, res) => {
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

// Horarios por cliente
app.post('/api/cliente/horarios', (req, res) => {
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

// =============================================================================
// ENDPOINTS MÓVIL - COMIDAS
// =============================================================================

// POST /api/comidas - Guardar en MariaDB
app.post('/api/comidas', async (req, res) => {
  try {
    const { id_cli, fecha, hora, calorias_totales, grupo_alimenticio, mensaje_validacion } = req.body;

    console.log('📝 Guardando comida en MariaDB:', req.body);

    if (!id_cli || !fecha || !hora || !calorias_totales || !grupo_alimenticio) {
      return res.status(400).json({
        success: false,
        message: 'Faltan datos requeridos'
      });
    }

    const query = `
      INSERT INTO comidas_registradas 
      (id_cli, fecha, hora, calorias_totales, grupo_alimenticio, mensaje_validacion) 
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    const [result] = await pool.execute(query, [
      id_cli,
      fecha,
      hora,
      calorias_totales,
      grupo_alimenticio,
      mensaje_validacion || 'Comida registrada exitosamente'
    ]);

    console.log('✅ Comida guardada en MariaDB con ID:', result.insertId);

    res.json({
      success: true,
      message: 'Comida registrada exitosamente',
      id_comida: result.insertId
    });

  } catch (error) {
    console.error('❌ Error guardando comida en MariaDB:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

// POST /api/comidas/mongo - Guardar en MongoDB
app.post('/api/comidas/mongo', async (req, res) => {
  try {
    const {
      id_cli,
      id_comida,
      nombre_alimento,
      grupo_alimenticio,
      gramos_pesados,
      gramos_recomendados,
      calorias_estimadas,
      fecha,
      hora,
      informacion_nutricional
    } = req.body;

    console.log('📝 Guardando comida en MongoDB:', req.body);

    if (!id_cli || !id_comida || !nombre_alimento) {
      return res.status(400).json({
        success: false,
        message: 'Faltan datos requeridos para MongoDB'
      });
    }

    if (!mongoDB) {
      throw new Error('MongoDB no está conectado');
    }

    const documento = {
      id_cli: parseInt(id_cli),
      id_comida: parseInt(id_comida),
      nombre_alimento: nombre_alimento || 'Alimento no especificado',
      grupo_alimenticio: grupo_alimenticio || 'General',
      gramos_pesados: parseFloat(gramos_pesados) || 0,
      gramos_recomendados: parseFloat(gramos_recomendados) || 0,
      calorias_estimadas: parseFloat(calorias_estimadas) || 0,
      fecha: fecha || new Date().toISOString().split('T')[0],
      hora: hora || new Date().toTimeString().split(' ')[0],
      timestamp: new Date(),
      estado: 'registrado'
    };

    if (informacion_nutricional && typeof informacion_nutricional === 'object') {
      documento.informacion_nutricional = {
        proteinas: parseFloat(informacion_nutricional.proteinas) || 0,
        carbohidratos: parseFloat(informacion_nutricional.carbohidratos) || 0,
        grasas: parseFloat(informacion_nutricional.grasas) || 0,
        fibra: parseFloat(informacion_nutricional.fibra) || 0
      };

      if (informacion_nutricional.nutriscore && 
          typeof informacion_nutricional.nutriscore === 'string' && 
          informacion_nutricional.nutriscore.length > 0) {
        documento.informacion_nutricional.nutriscore = informacion_nutricional.nutriscore;
      }

      if (informacion_nutricional.novaGroup !== null && 
          informacion_nutricional.novaGroup !== undefined && 
          !isNaN(parseInt(informacion_nutricional.novaGroup))) {
        documento.informacion_nutricional.novaGroup = parseInt(informacion_nutricional.novaGroup);
      }
    } else {
      documento.informacion_nutricional = {
        proteinas: 0,
        carbohidratos: 0,
        grasas: 0,
        fibra: 0
      };
    }

    console.log('📝 Documento preparado para MongoDB:', JSON.stringify(documento, null, 2));

    const collection = mongoDB.collection('comidas_detalladas');
    const result = await collection.insertOne(documento);

    console.log('✅ Comida guardada en MongoDB con ID:', result.insertedId);

    res.json({
      success: true,
      message: 'Comida registrada en MongoDB exitosamente',
      mongoId: result.insertedId
    });

  } catch (error) {
    console.error('❌ Error guardando comida en MongoDB:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor MongoDB',
      error: error.message
    });
  }
});

// GET /api/comidas/:id_cli - Obtener comidas de un cliente
app.get('/api/comidas/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const { fecha } = req.query;

    let query = `
      SELECT * FROM comidas_registradas 
      WHERE id_cli = ?
    `;
    let params = [id_cli];

    if (fecha) {
      query += ' AND fecha = ?';
      params.push(fecha);
    }

    query += ' ORDER BY fecha DESC, hora DESC';

    const [rows] = await pool.execute(query, params);

    res.json({
      success: true,
      comidas: rows
    });

  } catch (error) {
    console.error('❌ Error obteniendo comidas:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo comidas',
      error: error.message
    });
  }
});

// GET /api/comidas/mongo/:id_cli - Obtener detalles de MongoDB
app.get('/api/comidas/mongo/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const { fecha, id_comida } = req.query;

    if (!mongoDB) {
      throw new Error('MongoDB no está conectado');
    }

    const collection = mongoDB.collection('comidas_detalladas');
    
    let filter = { id_cli: parseInt(id_cli) };
    
    if (fecha) {
      filter.fecha = fecha;
    }
    
    if (id_comida) {
      filter.id_comida = parseInt(id_comida);
    }

    const comidas = await collection.find(filter)
      .sort({ timestamp: -1 })
      .toArray();

    res.json({
      success: true,
      comidas: comidas
    });

  } catch (error) {
    console.error('❌ Error obteniendo comidas de MongoDB:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo comidas detalladas',
      error: error.message
    });
  }
});

// GET /api/comidas/stats/:id_cli - Obtener estadísticas
app.get('/api/comidas/stats/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const { dias = 7 } = req.query;

    const query = `
      SELECT 
        fecha,
        COUNT(*) as total_comidas,
        SUM(calorias_totales) as total_calorias,
        GROUP_CONCAT(DISTINCT grupo_alimenticio) as grupos,
        MIN(hora) as primera_comida,
        MAX(hora) as ultima_comida
      FROM comidas_registradas 
      WHERE id_cli = ? 
        AND fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY fecha
      ORDER BY fecha DESC
    `;

    const [rows] = await pool.execute(query, [id_cli, parseInt(dias)]);

    const totalQuery = `
      SELECT 
        COUNT(*) as total_comidas_periodo,
        SUM(calorias_totales) as total_calorias_periodo,
        AVG(calorias_totales) as promedio_calorias_comida,
        COUNT(DISTINCT grupo_alimenticio) as grupos_diferentes
      FROM comidas_registradas 
      WHERE id_cli = ? 
        AND fecha >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    `;

    const [totalRows] = await pool.execute(totalQuery, [id_cli, parseInt(dias)]);

    res.json({
      success: true,
      estadisticas_diarias: rows,
      resumen_periodo: totalRows[0],
      periodo_dias: parseInt(dias)
    });

  } catch (error) {
    console.error('❌ Error obteniendo estadísticas:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo estadísticas',
      error: error.message
    });
  }
});

// GET /api/comidas/weekly/:id_cli - Obtener resumen semanal
app.get('/api/comidas/weekly/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    
    console.log('📅 Obteniendo resumen semanal para cliente:', id_cli);
    
    const today = new Date();
    const currentDay = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - (currentDay === 0 ? 6 : currentDay - 1));

    const weekDates = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      weekDates.push(date.toISOString().split('T')[0]);
    }

    console.log('📅 Fechas de la semana calculadas:', weekDates);

    const query = `
      SELECT 
        DATE(fecha) as fecha_formateada,
        SUM(calorias_totales) as calorias_dia,
        COUNT(*) as comidas_dia
      FROM comidas_registradas 
      WHERE id_cli = ? 
      GROUP BY DATE(fecha)
      ORDER BY DATE(fecha)
    `;

    const [rows] = await pool.execute(query, [id_cli]);
    
    console.log('📅 Todos los datos de BD:', rows);

    const weeklyData = {
      lunes: 0, martes: 0, miercoles: 0, jueves: 0, 
      viernes: 0, sabado: 0, domingo: 0
    };

    const dayNames = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
    
    rows.forEach((row) => {
      let fechaRow;
      if (row.fecha_formateada instanceof Date) {
        fechaRow = row.fecha_formateada.toISOString().split('T')[0];
      } else {
        fechaRow = row.fecha_formateada;
      }
      
      console.log(`📅 Procesando fecha: ${fechaRow} con ${row.calorias_dia} calorías`);
      
      const dateIndex = weekDates.indexOf(fechaRow);
      if (dateIndex !== -1) {
        const dayName = dayNames[dateIndex];
        weeklyData[dayName] = parseInt(row.calorias_dia) || 0;
        console.log(`📅 Asignado ${row.calorias_dia} calorías a ${dayName} (índice ${dateIndex})`);
      } else {
        console.log(`📅 Fecha ${fechaRow} no está en la semana actual`);
      }
    });

    console.log('📅 Resumen semanal final:', weeklyData);

    res.json({
      success: true,
      semana: weeklyData,
      fechas: weekDates,
      datos_detallados: rows,
      debug: {
        fechas_semana: weekDates,
        fechas_bd: rows.map(r => r.fecha_formateada),
        total_filas: rows.length
      }
    });

  } catch (error) {
    console.error('❌ Error obteniendo resumen semanal:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo resumen semanal',
      error: error.message
    });
  }
});

// GET /api/comidas/daily/:id_cli - Obtener consumo por horas
app.get('/api/comidas/daily/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const { fecha } = req.query;
    const targetDate = fecha || new Date().toISOString().split('T')[0];

    console.log('🕐 Obteniendo consumo diario por horas para cliente:', id_cli, 'fecha:', targetDate);

    const hourlyQuery = `
      SELECT 
        HOUR(hora) as hora_del_dia,
        COUNT(*) as comidas_hora,
        SUM(calorias_totales) as calorias_hora,
        GROUP_CONCAT(DISTINCT grupo_alimenticio) as grupos_hora,
        GROUP_CONCAT(CONCAT(TIME_FORMAT(hora, '%H:%i'), ' - ', SUBSTRING(mensaje_validacion, 1, 30))) as detalles_hora
      FROM comidas_registradas 
      WHERE id_cli = ? AND fecha = ?
      GROUP BY HOUR(hora)
      ORDER BY HOUR(hora)
    `;

    const [hourlyRows] = await pool.execute(hourlyQuery, [id_cli, targetDate]);

    const hourlyData = Array.from({ length: 24 }, (_, hour) => {
      const dataForHour = hourlyRows.find(row => row.hora_del_dia === hour);
      return {
        hora: hour,
        calorias: dataForHour ? parseInt(dataForHour.calorias_hora) : 0,
        comidas: dataForHour ? parseInt(dataForHour.comidas_hora) : 0,
        grupos: dataForHour ? dataForHour.grupos_hora : null,
        detalles: dataForHour ? dataForHour.detalles_hora : null
      };
    });

    const dayStatsQuery = `
      SELECT 
        COUNT(*) as total_comidas,
        SUM(calorias_totales) as total_calorias,
        AVG(calorias_totales) as promedio_calorias_comida,
        MIN(hora) as primera_comida,
        MAX(hora) as ultima_comida,
        COUNT(DISTINCT grupo_alimenticio) as grupos_diferentes
      FROM comidas_registradas 
      WHERE id_cli = ? AND fecha = ?
    `;

    const [dayStatsRows] = await pool.execute(dayStatsQuery, [id_cli, targetDate]);

    const resultado = {
      success: true,
      fecha: targetDate,
      datos_por_hora: hourlyData,
      estadisticas_dia: dayStatsRows[0],
      picos_consumo: hourlyData
        .filter(h => h.calorias > 0)
        .sort((a, b) => b.calorias - a.calorias)
        .slice(0, 3)
    };

    console.log('🕐 Datos diarios procesados:', {
      total_horas_con_datos: hourlyData.filter(h => h.calorias > 0).length,
      total_calorias: dayStatsRows[0]?.total_calorias || 0
    });

    res.json(resultado);

  } catch (error) {
    console.error('❌ Error obteniendo datos diarios:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo datos diarios',
      error: error.message
    });
  }
});

// GET /api/comidas/summary/:id_cli - Obtener resumen completo
app.get('/api/comidas/summary/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const today = new Date().toISOString().split('T')[0];

    console.log('📊 Obteniendo resumen completo para cliente:', id_cli, 'fecha:', today);

    const todayQuery = `
      SELECT 
        COUNT(*) as comidas_hoy,
        COALESCE(SUM(calorias_totales), 0) as calorias_hoy,
        GROUP_CONCAT(DISTINCT grupo_alimenticio) as grupos_hoy,
        MIN(hora) as primera_comida_hoy,
        MAX(hora) as ultima_comida_hoy
      FROM comidas_registradas 
      WHERE id_cli = ? AND fecha = ?
    `;

    const [todayRows] = await pool.execute(todayQuery, [id_cli, today]);

    const weekQuery = `
      SELECT 
        COUNT(*) as comidas_semana,
        COALESCE(SUM(calorias_totales), 0) as calorias_semana,
        COALESCE(AVG(calorias_totales), 0) as promedio_calorias_comida,
        COUNT(DISTINCT grupo_alimenticio) as grupos_diferentes_semana
      FROM comidas_registradas 
      WHERE id_cli = ? 
        AND fecha >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
    `;

    const [weekRows] = await pool.execute(weekQuery, [id_cli]);

    const totalQuery = `
      SELECT 
        COUNT(*) as total_comidas,
        COALESCE(SUM(calorias_totales), 0) as total_calorias,
        COALESCE(AVG(calorias_totales), 0) as promedio_comida,
        MIN(fecha) as primera_fecha,
        MAX(fecha) as ultima_fecha,
        COUNT(DISTINCT fecha) as dias_activos
      FROM comidas_registradas 
      WHERE id_cli = ?
    `;

    const [totalRows] = await pool.execute(totalQuery, [id_cli]);

    const groupsQuery = `
      SELECT 
        grupo_alimenticio,
        COUNT(*) as veces_consumido,
        SUM(calorias_totales) as calorias_grupo
      FROM comidas_registradas 
      WHERE id_cli = ?
      GROUP BY grupo_alimenticio
      ORDER BY veces_consumido DESC
      LIMIT 5
    `;

    const [groupsRows] = await pool.execute(groupsQuery, [id_cli]);

    const resultado = {
      success: true,
      resumen_hoy: todayRows[0],
      resumen_semana: weekRows[0],
      resumen_total: totalRows[0],
      grupos_favoritos: groupsRows,
      fecha_consulta: today
    };

    console.log('📊 Resumen completo:', resultado);

    res.json(resultado);

  } catch (error) {
    console.error('❌ Error obteniendo resumen completo:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo resumen completo',
      error: error.message
    });
  }
});

// GET /api/user/profile/:id_cli - Obtener perfil del usuario
app.get('/api/user/profile/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;

    console.log('👤 Obteniendo perfil para cliente:', id_cli);

    const query = `
      SELECT 
        id_cli,
        CONCAT(nombre_cli, ' ', app_cli, ' ', apm_cli) as nombre_completo,
        correo_cli,
        edad_cli,
        sexo_cli,
        peso_cli,
        estatura_cli,
        faf_cli,
        geb_cli,
        modo,
        tiene_acceso
      FROM clientes 
      WHERE id_cli = ?
    `;

    const [rows] = await pool.execute(query, [id_cli]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    const usuario = rows[0];

    let bmr = 0;
    if (usuario.sexo_cli === 'M' || usuario.sexo_cli === 'Masculino') {
      bmr = 88.362 + (13.397 * usuario.peso_cli) + (4.799 * usuario.estatura_cli) - (5.677 * usuario.edad_cli);
    } else {
      bmr = 447.593 + (9.247 * usuario.peso_cli) + (3.098 * usuario.estatura_cli) - (4.330 * usuario.edad_cli);
    }

    const metaCalorica = Math.round(bmr * (usuario.faf_cli || 1.2));

    const resultado = {
      success: true,
      usuario: {
        ...usuario,
        meta_calorica_calculada: metaCalorica,
        imc: (usuario.peso_cli / Math.pow(usuario.estatura_cli / 100, 2)).toFixed(1)
      }
    };

    console.log('👤 Perfil obtenido:', resultado);

    res.json(resultado);

  } catch (error) {
    console.error('❌ Error obteniendo perfil:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo perfil de usuario',
      error: error.message
    });
  }
});

// POST para obtener la dieta actual del cliente
app.post('/api/dieta-actual', async (req, res) => {
  const { idCliente } = req.body;

  if (!idCliente || isNaN(idCliente)) {
    return res.status(400).json({ error: 'ID de cliente inválido' });
  }

  try {
    const query = `
      SELECT 
        d.id_dieta,
        d.nombre_dieta,
        d.objetivo_dieta,
        d.duracion,
        d.porcentaje_proteinas,
        d.porcentaje_carbs,
        d.porcentaje_grasas,
        d.calorias_objetivo,
        d.recomendaciones,
        d.fecha_inicio as fecha_creacion,
        tc.id_tiempo,
        tc.nombre_tiempo,
        ad.id_alimento_dieta,
        ad.nombre_alimento,
        ad.cantidad_gramos,
        ad.calorias,
        ad.grupo_alimenticio
      FROM 
        dietas d
      LEFT JOIN 
        tiempos_comida tc ON d.id_dieta = tc.id_dieta
      LEFT JOIN 
        alimentos_dieta ad ON tc.id_tiempo = ad.id_tiempo
      WHERE 
        d.id_cli = ?
      ORDER BY 
        d.fecha_inicio DESC, 
        tc.id_tiempo ASC,
        ad.id_alimento_dieta ASC
      LIMIT 100
    `;

    const [results] = await pool.execute(query, [idCliente]);

    if (results.length === 0) {
      return res.json(null);
    }

    const dietaData = {
      id_dieta: results[0].id_dieta,
      nombre_dieta: results[0].nombre_dieta,
      objetivo_dieta: results[0].objetivo_dieta,
      duracion: results[0].duracion,
      porcentaje_proteinas: results[0].porcentaje_proteinas,
      porcentaje_carbs: results[0].porcentaje_carbs,
      porcentaje_grasas: results[0].porcentaje_grasas,
      calorias_objetivo: results[0].calorias_objetivo,
      recomendaciones: results[0].recomendaciones,
      fecha_creacion: results[0].fecha_creacion,
      tiempos: []
    };

    const tiemposMap = new Map();

    results.forEach(row => {
      if (!row.id_tiempo) return;

      if (!tiemposMap.has(row.id_tiempo)) {
        tiemposMap.set(row.id_tiempo, {
          id_tiempo: row.id_tiempo,
          nombre_tiempo: row.nombre_tiempo,
          alimentos: []
        });
      }

      if (row.id_alimento_dieta) {
        tiemposMap.get(row.id_tiempo).alimentos.push({
          id_alimento_dieta: row.id_alimento_dieta,
          nombre_alimento: row.nombre_alimento,
          cantidad_gramos: row.cantidad_gramos,
          calorias: row.calorias,
          grupo_alimenticio: row.grupo_alimenticio
        });
      }
    });

    dietaData.tiempos = Array.from(tiemposMap.values()).sort((a, b) => {
      const orden = ['desayuno', 'colacion1', 'comida', 'colacion2', 'cena'];
      return orden.indexOf(a.nombre_tiempo) - orden.indexOf(b.nombre_tiempo);
    });

    console.log('✅ Dieta encontrada para cliente', idCliente, ':', dietaData.nombre_dieta);

    res.json(dietaData);

  } catch (error) {
    console.error('❌ Error al obtener dieta actual:', error);
    res.status(500).json({ error: 'Error en la base de datos' });
  }
});

// =============================================================================
// ENDPOINTS FORMULARIOS
// =============================================================================

app.post('/api/submit-nutrition-form', async (req, res) => {
  try {
    const { userId, userEmail, userName, formData } = req.body;

    if (!userId || !userEmail || !formData) {
      return res.status(400).json({
        success: false,
        message: 'Datos incompletos'
      });
    }

    const {
      motivo, antecedentesHeredofamiliares, antecedentesPersonalesNoPatologicos,
      antecedentesPersonalesPatologicos, alergiasIntolerancias, aversionesAlimentarias
    } = formData;

    if (!motivo || !antecedentesHeredofamiliares || !antecedentesPersonalesNoPatologicos || 
        !antecedentesPersonalesPatologicos || !alergiasIntolerancias || !aversionesAlimentarias) {
      return res.status(400).json({
        success: false,
        message: 'Todos los campos del formulario son requeridos'
      });
    }

    const connection = await mysql.createConnection(dbConfig);

    try {
      const [result] = await connection.execute(
        `INSERT INTO formularios_nutricion (
          id_cliente, motivo, antecedentes_heredofamiliares,
          antecedentes_personales_no_patologicos, antecedentes_personales_patologicos,
          alergias_intolerancias, aversiones_alimentarias, estado
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente')`,
        [
          userId, motivo, antecedentesHeredofamiliares,
          antecedentesPersonalesNoPatologicos, antecedentesPersonalesPatologicos,
          alergiasIntolerancias, aversionesAlimentarias
        ]
      );

      res.json({
        success: true,
        message: 'Formulario enviado exitosamente',
        formId: result.insertId
      });

    } finally {
      await connection.end();
    }

  } catch (error) {
    console.error('Error en formulario nutricional:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// =============================================================================
// ENDPOINTS IOT
// =============================================================================

app.get('/api/iot/scale/status', (req, res) => {
  res.json({
    connected: scaleState.connected,
    lastUpdate: scaleState.lastUpdate,
    calibrated: scaleState.calibrated
  });
});

app.get('/api/iot/pedometer/status', (req, res) => {
  res.json({
    success: true,
    connected: pedometerState.connected,
    steps: pedometerState.steps,
    isCountingSteps: pedometerState.isCountingSteps,
    lastUpdate: pedometerState.lastUpdate,
    dailyGoal: pedometerState.dailyGoal,
    deviceName: pedometerState.deviceName,
    batteryLevel: pedometerState.batteryLevel,
    progressPercentage: ((pedometerState.steps / pedometerState.dailyGoal) * 100).toFixed(1)
  });
});

app.post('/api/iot/pedometer/command', (req, res) => {
  try {
    const { command, userId } = req.body;
    
    console.log('👟 Comando recibido para podómetro:', command);
    
    if (!pedometerState.connected) {
      return res.status(400).json({
        success: false,
        message: 'Podómetro ESP32 no conectado'
      });
    }

    const commandPayload = {
      type: 'pedometer_command',
      command: command,
      userId: userId,
      timestamp: new Date().toISOString()
    };

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(commandPayload));
      }
    });

    if (command === 'start') {
      pedometerState.isCountingSteps = true;
    } else if (command === 'stop') {
      pedometerState.isCountingSteps = false;
    } else if (command === 'reset') {
      pedometerState.steps = 0;
    }

    console.log('👟 Comando enviado al ESP32:', commandPayload);

    res.json({
      success: true,
      message: `Comando '${command}' enviado al podómetro`,
      command: command,
      newState: {
        steps: pedometerState.steps,
        isCountingSteps: pedometerState.isCountingSteps
      }
    });

  } catch (error) {
    console.error('❌ Error enviando comando al podómetro:', error);
    res.status(500).json({
      success: false,
      message: 'Error enviando comando al podómetro',
      error: error.message
    });
  }
});

app.get('/api/iot/pedometer/steps/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const { fecha } = req.query;
    const targetDate = fecha || new Date().toISOString().split('T')[0];

    console.log('👟 Obteniendo pasos para usuario:', id_cli, 'fecha:', targetDate);

    const query = `
      SELECT 
        pasos_totales,
        calorias_quemadas,
        hora_actualizacion,
        last_update
      FROM actividad_fisica 
      WHERE id_cli = ? AND fecha = ? AND tipo_actividad = 'pasos'
      ORDER BY last_update DESC
      LIMIT 1
    `;

    const [rows] = await pool.execute(query, [id_cli, targetDate]);

    if (rows.length > 0) {
      const data = rows[0];
      res.json({
        success: true,
        steps: data.pasos_totales || 0,
        caloriesBurned: data.calorias_quemadas || 0,
        lastUpdate: data.last_update,
        date: targetDate,
        goalProgress: ((data.pasos_totales / 10000) * 100).toFixed(1)
      });
    } else {
      res.json({
        success: true,
        steps: 0,
        caloriesBurned: 0,
        lastUpdate: null,
        date: targetDate,
        goalProgress: '0.0'
      });
    }

  } catch (error) {
    console.error('❌ Error obteniendo pasos:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo datos de pasos',
      error: error.message
    });
  }
});

app.get('/api/iot/pedometer/steps/mongo/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const { fecha } = req.query;

    if (!mongoDB) {
      return res.status(500).json({
        success: false,
        message: 'MongoDB no está disponible'
      });
    }

    console.log('👟 Obteniendo pasos de MongoDB para usuario:', id_cli);

    const collection = mongoDB.collection('actividad_pasos');

    const filter = {
      id_cli: parseInt(id_cli),
      ...(fecha && { fecha: fecha })
    };

    console.log('🔍 Filtro de búsqueda:', filter);

    const documentos = await collection
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(1)
      .toArray();

    const documento = documentos[0];

    if (documento) {
      res.json({
        success: true,
        data: {
          fecha: documento.fecha,
          pasos: documento.pasos,
          calorias_gastadas: documento.calorias_gastadas,
          distancia_km: documento.distancia_km,
          hora_ultima_actualizacion: documento.hora_ultima_actualizacion,
          dispositivo: documento.dispositivo
        }
      });
    } else {
      res.json({
        success: true,
        data: {
          fecha: fecha,
          pasos: 0,
          calorias_gastadas: 0,
          distancia_km: 0,
          hora_ultima_actualizacion: null,
          dispositivo: null
        }
      });
    }
  } catch (error) {
    console.error('❌ Error obteniendo pasos de MongoDB:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo datos de pasos desde MongoDB',
      error: error.message
    });
  }
});

app.post('/api/iot/pedometer/save', async (req, res) => {
  try {
    const { id_cli, steps, fecha } = req.body;
    
    console.log('💾 === GUARDANDO PASOS EN BD ===');
    console.log('📥 Datos recibidos:', { id_cli, steps, fecha });
    
    if (!id_cli || steps === undefined || steps === null) {
      console.log('❌ Datos incompletos:', { id_cli, steps, fecha });
      return res.status(400).json({
        success: false,
        message: 'ID de usuario y pasos son requeridos'
      });
    }

    const today = fecha || new Date().toISOString().split('T')[0];
    const horaActual = new Date().toTimeString().split(' ')[0].slice(0, 5);
    const caloriasGastadas = Math.round(steps * 0.04);
    const distanciaKm = +(steps * 0.75 / 1000).toFixed(2);

    if (!mongoDB) {
      console.log('❌ MongoDB no está conectado');
      return res.status(500).json({ 
        success: false, 
        message: 'Base de datos MongoDB no disponible' 
      });
    }

    let mongoResult = null;
    try {
      const collection = mongoDB.collection('actividad_pasos');
      
      const filter = {
        id_cli: parseInt(id_cli),
        fecha: today
      };
      
      const existingDoc = await collection.findOne(filter);

      const documentoMongo = {
        id_cli: parseInt(id_cli),
        fecha: today,
        pasos: parseInt(steps),
        calorias_gastadas: caloriasGastadas,
        distancia_km: distanciaKm,
        hora_ultima_actualizacion: horaActual,
        dispositivo: 'ESP32',
        estado: 'activo',
        timestamp: new Date()
      };

      if (existingDoc) {
        const updateResult = await collection.updateOne(
          { _id: existingDoc._id },
          { 
            $set: {
              pasos: parseInt(steps),
              calorias_gastadas: caloriasGastadas,
              distancia_km: distanciaKm,
              hora_ultima_actualizacion: horaActual,
              timestamp: new Date()
            }
          }
        );
        
        mongoResult = { updated: true, id: existingDoc._id };
      } else {
        const insertResult = await collection.insertOne(documentoMongo);
        mongoResult = { inserted: true, id: insertResult.insertedId };
      }

    } catch (mongoError) {
      console.error('❌ Error específico de MongoDB:', mongoError);
    }

    // Guardar en MySQL como backup
    try {
      const connection = await mysql.createConnection(dbConfig);
      
      try {
        const [existingRows] = await connection.execute(
          `SELECT id_actividad FROM actividad_fisica 
           WHERE id_cli = ? AND fecha = ? AND tipo_actividad = 'pasos'`,
          [id_cli, today]
        );

        if (existingRows.length > 0) {
          await connection.execute(
            `UPDATE actividad_fisica 
             SET pasos_totales = ?, calorias_quemadas = ?, hora_actualizacion = ?, last_update = NOW()
             WHERE id_cli = ? AND fecha = ? AND tipo_actividad = 'pasos'`,
            [steps, caloriasGastadas, horaActual, id_cli, today]
          );
          console.log('🔄 Actualizado en MySQL');
        } else {
          await connection.execute(
            `INSERT INTO actividad_fisica 
             (id_cli, fecha, hora_actualizacion, tipo_actividad, pasos_totales, calorias_quemadas, last_update) 
             VALUES (?, ?, ?, 'pasos', ?, ?, NOW())`,
            [id_cli, today, horaActual, steps, caloriasGastadas]
          );
          console.log('➕ Insertado en MySQL');
        }
      } finally {
        await connection.end();
      }
    } catch (mysqlError) {
      console.log('⚠️ Error en MySQL (no crítico):', mysqlError.message);
    }

    res.json({
      success: true,
      message: 'Pasos guardados exitosamente',
      steps: parseInt(steps),
      date: today,
      saved_to: mongoResult ? ['mongodb', 'mysql'] : ['mysql'],
      mongo_result: mongoResult
    });

  } catch (error) {
    console.error('❌ Error general en save endpoint:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

// Asignar podómetro
app.post('/api/iot/pedometer/assign', async (req, res) => {
  try {
    const { user_id, user_name, device_id } = req.body;
    
    console.log('📱 === ASIGNANDO PODÓMETRO ===');
    console.log('📥 Datos recibidos:', { user_id, user_name, device_id });
    
    if (!user_id || !user_name) {
      return res.status(400).json({
        success: false,
        message: 'user_id y user_name son requeridos'
      });
    }
    
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [userRows] = await connection.execute(
        'SELECT id_cli, CONCAT(nombre_cli, " ", app_cli) as nombre FROM clientes WHERE id_cli = ?',
        [user_id]
      );
      
      if (userRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Usuario no encontrado'
        });
      }
      
      const deviceKey = device_id || 'default';
      
      const assignment = {
        user_id: parseInt(user_id),
        user_name: user_name,
        device_id: deviceKey,
        assigned_at: new Date().toISOString(),
        status: 'active'
      };
      
      connectedPedometers.set(deviceKey, assignment);
      
      console.log('✅ Podómetro asignado:', assignment);
      
      res.json({
        success: true,
        message: 'Usuario asignado al podómetro exitosamente',
        assignment: assignment
      });
      
    } finally {
      await connection.end();
    }
    
  } catch (error) {
    console.error('❌ Error asignando podómetro:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

// Liberar podómetro
app.post('/api/iot/pedometer/release', async (req, res) => {
  try {
    const { device_id, user_id } = req.body;
    
    console.log('📱 === LIBERANDO PODÓMETRO ===');
    console.log('📥 Datos recibidos:', { device_id, user_id });
    
    const deviceKey = device_id || 'default';
    const assignment = connectedPedometers.get(deviceKey);
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'No hay podómetro asignado'
      });
    }
    
    if (user_id && assignment.user_id !== user_id) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para liberar este podómetro'
      });
    }
    
    console.log('✅ Liberando podómetro de usuario:', assignment.user_name);
    
    connectedPedometers.delete(deviceKey);
    
    res.json({
      success: true,
      message: 'Podómetro liberado exitosamente',
      former_assignment: assignment
    });
    
  } catch (error) {
    console.error('❌ Error liberando podómetro:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// Obtener asignaciones
app.get('/api/iot/pedometer/assignments', (req, res) => {
  try {
    const assignments = Array.from(connectedPedometers.values());
    
    console.log('📱 === CONSULTANDO ASIGNACIONES ===');
    console.log('📋 Asignaciones activas:', assignments.length);
    
    res.json({
      success: true,
      total_assignments: assignments.length,
      assignments: assignments.map(assignment => ({
        user_id: assignment.user_id,
        user_name: assignment.user_name,
        device_id: assignment.device_id,
        assigned_at: assignment.assigned_at,
        status: assignment.status,
        duration_minutes: Math.round((new Date() - new Date(assignment.assigned_at)) / (1000 * 60))
      }))
    });
    
  } catch (error) {
    console.error('❌ Error obteniendo asignaciones:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo asignaciones',
      error: error.message
    });
  }
});

// Verificar dispositivos disponibles
app.get('/api/iot/pedometer/available', (req, res) => {
  try {
    const totalDevices = 3;
    const assignedDevices = connectedPedometers.size;
    const availableDevices = Math.max(0, totalDevices - assignedDevices);
    
    console.log('📱 === DISPOSITIVOS DISPONIBLES ===');
    console.log('📊 Total:', totalDevices, 'Asignados:', assignedDevices, 'Disponibles:', availableDevices);
    
    res.json({
      success: true,
      total_devices: totalDevices,
      assigned_devices: assignedDevices,
      available_devices: availableDevices,
      devices: Array.from(connectedPedometers.keys())
    });
    
  } catch (error) {
    console.error('❌ Error verificando disponibilidad:', error);
    res.status(500).json({
      success: false,
      message: 'Error verificando disponibilidad',
      error: error.message
    });
  }
});

// Endpoints báscula
app.get('/api/iot/scale/weight', (req, res) => {
  if (!scaleState.connected) {
    return res.status(400).json({
      success: false,
      message: 'Báscula no conectada'
    });
  }

  const simulatedWeight = Math.floor(Math.random() * 500) + 50;
  scaleState.weight = simulatedWeight;
  scaleState.lastUpdate = new Date();

  res.json({
    success: true,
    weight: simulatedWeight,
    timestamp: scaleState.lastUpdate
  });
});

app.post('/api/iot/scale/send', async (req, res) => {
  try {
    const {
      id_cli,
      nombre_alimento,
      grupo_alimenticio,
      gramos_recomendados,
      calorias_estimadas,
      fecha,
      hora
    } = req.body;

    console.log('📤 Enviando datos a báscula:', req.body);

    if (!scaleState.connected) {
      return res.status(400).json({
        success: false,
        message: 'Báscula no conectada'
      });
    }

    const scalePayload = {
      type: 'food_data',
      data: {
        cliente_id: id_cli,
        alimento: nombre_alimento,
        categoria: grupo_alimenticio,
        peso_objetivo: gramos_recomendados,
        calorias: calorias_estimadas,
        timestamp: new Date().toISOString()
      }
    };

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(scalePayload));
      }
    });

    console.log('📤 Datos enviados a báscula:', scalePayload);

    res.json({
      success: true,
      message: 'Datos enviados a báscula exitosamente',
      payload: scalePayload
    });

  } catch (error) {
    console.error('❌ Error enviando datos a báscula:', error);
    res.status(500).json({
      success: false,
      message: 'Error enviando datos a báscula',
      error: error.message
    });
  }
});

app.post('/api/iot/scale/calibrate', (req, res) => {
  if (!scaleState.connected) {
    return res.status(400).json({
      success: false,
      message: 'Báscula no conectada'
    });
  }

  const calibrateCommand = {
    type: 'calibrate',
    timestamp: new Date().toISOString()
  };

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(calibrateCommand));
    }
  });

  scaleState.calibrated = true;
  
  res.json({
    success: true,
    message: 'Comando de calibración enviado'
  });
});

// =============================================================================
// ENDPOINTS ADICIONALES WEB
// =============================================================================

// Obtener pasos por usuario (WEB)
app.get('/api/pasos/:id_cli', async (req, res) => {
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

// Obtener dietas por id de cliente (WEB)
app.get('/api/obdietas/:id_cliente', async (req, res) => {
  const idCliente = req.params.id_cliente;
  try {
    const connection = await mysql.createConnection(dbConfig);
    try {
      const query = `SELECT * FROM dietas WHERE id_cli = ? ORDER BY fecha_inicio DESC`;
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

// Debug MongoDB
app.get('/api/debug/mongodb/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    
    console.log('🔍 === DEBUGGING MONGODB ===');
    console.log('Usuario solicitado:', id_cli);
    
    if (!mongoDB) {
      return res.json({ 
        success: false, 
        error: 'MongoDB no conectado',
        debug: {
          mongoDB: null,
          connected: false
        }
      });
    }

    const collection = mongoDB.collection('actividad_pasos');
    
    const totalDocs = await collection.countDocuments();
    const allDocs = await collection.find({}).toArray();
    const userDocs = await collection.find({ id_cli: parseInt(id_cli) }).toArray();
    
    const today = new Date().toISOString().split('T')[0];
    const todayDocs = await collection.find({ fecha: today }).toArray();
    
    const userTodayDocs = await collection.find({ 
      id_cli: parseInt(id_cli), 
      fecha: today 
    }).toArray();
    
    const recentDocs = await collection.find({})
      .sort({ timestamp: -1 })
      .limit(10)
      .toArray();

    res.json({
      success: true,
      debug: {
        database_name: mongoDB.databaseName,
        collection_name: 'actividad_pasos',
        total_documents: totalDocs,
        all_documents: allDocs,
        user_documents: userDocs,
        today_documents: todayDocs,
        user_today_documents: userTodayDocs,
        recent_documents: recentDocs,
        searched_user_id: parseInt(id_cli),
        searched_date: today,
        current_time: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Error en debugging:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      debug: {
        error_stack: error.stack
      }
    });
  }
});

// Insertar datos de prueba
app.post('/api/debug/insert-test-data/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const today = new Date().toISOString().split('T')[0];
    
    if (!mongoDB) {
      return res.json({ success: false, error: 'MongoDB no conectado' });
    }

    const collection = mongoDB.collection('actividad_pasos');
    
    const testDocument = {
      id_cli: parseInt(id_cli),
      fecha: today,
      pasos: 1234,
      calorias_gastadas: 49,
      distancia_km: 0.93,
      hora_ultima_actualizacion: new Date().toTimeString().split(' ')[0].slice(0, 5),
      dispositivo: 'ESP32_TEST',
      estado: 'activo',
      timestamp: new Date()
    };

    const result = await collection.insertOne(testDocument);
    
    console.log('✅ Documento de prueba insertado:', result.insertedId);
    
    res.json({
      success: true,
      message: 'Documento de prueba insertado',
      document_id: result.insertedId,
      document: testDocument
    });

  } catch (error) {
    console.error('❌ Error insertando datos de prueba:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// =============================================================================
// MIDDLEWARE DE LIMPIEZA Y MANEJO DE ERRORES
// =============================================================================

// Limpiar asignaciones expiradas cada hora
setInterval(() => {
  const now = new Date();
  const ASSIGNMENT_TIMEOUT = 6 * 60 * 60 * 1000; // 6 horas
  
  for (const [deviceId, assignment] of connectedPedometers.entries()) {
    if (now - new Date(assignment.assigned_at) > ASSIGNMENT_TIMEOUT) {
      console.log(`⏰ Liberando podómetro ${deviceId} por timeout`);
      connectedPedometers.delete(deviceId);
      
      const timeoutCommand = {
        type: 'assignment_timeout',
        device_id: deviceId,
        former_user_id: assignment.user_id
      };
      
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(timeoutCommand));
        }
      });
    }
  }
}, 60 * 60 * 1000); // Cada hora

// Manejo de errores globales
app.use((error, req, res, next) => {
  console.error('❌ Error global:', error);
  res.status(500).json({
    success: false,
    message: 'Error interno del servidor',
    error: error.message
  });
});


// Generar token de suscripción
const generateSubscriptionToken = (userId, planType, paymentId) => {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 4).toUpperCase();
  const planPrefix = planType === 'cliente' ? 'CLI' : 'NUT';
  
  return `SUB${planPrefix}${userId}${timestamp}${random}`;
};

// Guardar token en base de datos
const saveSubscriptionToken = async (userId, token, paymentId, planType) => {
  try {
    const connection = await mysql.createConnection(dbConfig);
    
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS subscription_tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token VARCHAR(50) UNIQUE NOT NULL,
        payment_id VARCHAR(100),
        plan_type VARCHAR(20) NOT NULL,
        status ENUM('active', 'used', 'expired') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL 7 DAY),
        used_at TIMESTAMP NULL,
        INDEX idx_token (token),
        INDEX idx_user_id (user_id),
        INDEX idx_status (status)
      )
    `);
    
    await connection.execute(
      `INSERT INTO subscription_tokens 
       (user_id, token, payment_id, plan_type) 
       VALUES (?, ?, ?, ?)`,
      [userId, token, paymentId, planType]
    );
    
    await connection.end();
    console.log(`✅ Token de suscripción guardado: ${token}`);
    return true;
  } catch (error) {
    console.error('❌ Error guardando token:', error);
    return false;
  }
};

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

// Middleware para verificar token de sesión (WEB)
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

  connection.query(sql, [id_nut], (err, results) => {
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

// =============================================================================
// ENDPOINTS BÁSICOS
// =============================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    services: {
      mysql: 'connected',
      mongodb: mongoDB ? 'connected' : 'disconnected',
      iot_scale: scaleState.connected ? 'connected' : 'disconnected'
    }
  });
});

app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'API funcionando correctamente',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/test-post', (req, res) => {
  console.log('Test POST - Headers:', req.headers);
  console.log('Test POST - Body:', req.body);
  res.json({
    success: true,
    message: 'POST funcionando',
    receivedData: req.body
  });
});

app.get('/api/mysql-test', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT NOW() AS now');
    res.json({ success: true, now: rows[0].now });
  } catch (err) {
    console.error('❌ Error conexión MySQL:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================================================
// ENDPOINTS DE AUTENTICACIÓN UNIFICADOS
// =============================================================================

// LOGIN UNIFICADO - Móvil y Web
app.post('/api/login', async (req, res) => {
  try {
    console.log('=== LOGIN ATTEMPT UNIFIED ===');
    const { correo, password } = req.body;

    if (!correo || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email y contraseña son requeridos'
      });
    }

    const connection = await mysql.createConnection(dbConfig);
    let user = null;
    let userType = null;

    try {
      // Buscar en administradores
      const [adminResults] = await connection.execute(
        'SELECT id_admin as id, tipo_usu, nombre_admin as nombre, correo, password, token FROM administradores WHERE correo = ?',
        [correo]
      );

      if (adminResults.length > 0) {
        user = adminResults[0];
        userType = 'admin';
      }

      // Buscar en nutriólogos
      if (!user) {
        const [nutResults] = await connection.execute(
          'SELECT id_nut as id, tipo_usu, CONCAT(nombre_nut, " ", app_nut, " ", apm_nut) as nombre, correo, password, cedula_nut, especialidad_nut, telefono_nut, activo, tiene_acceso, verificado, token FROM nutriologos WHERE correo = ?',
          [correo]
        );

        if (nutResults.length > 0) {
          user = nutResults[0];
          userType = 'nutriologo';
        }
      }

      // Buscar en clientes
      if (!user) {
        const [clientResults] = await connection.execute(
          'SELECT id_cli as id, tipo_usu, CONCAT(nombre_cli, " ", app_cli, " ", apm_cli) as nombre, correo_cli as correo, password_cli as password, edad_cli, sexo_cli, peso_cli, estatura_cli, faf_cli, geb_cli, modo, id_nut, tiene_acceso FROM clientes WHERE correo_cli = ?',
          [correo]
        );

        if (clientResults.length > 0) {
          user = clientResults[0];
          userType = 'cliente';
        }
      }

      await connection.end();

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Credenciales inválidas',
          error: 'Correo no registrado'
        });
      }

      // Validar contraseña - Web usa bcrypt, móvil usa texto plano
      let passwordMatch = false;
      if (userType === 'nutriologo' || userType === 'admin') {
        // Para web: usar bcrypt
        try {
          passwordMatch = await bcrypt.compare(password, user.password);
        } catch (e) {
          // Si falla bcrypt, probar comparación directa (compatibilidad)
          passwordMatch = password === user.password;
        }
      } else {
        // Para clientes móvil: comparación directa
        passwordMatch = password === user.password;
      }

      if (!passwordMatch) {
        return res.status(401).json({
          success: false,
          message: 'Credenciales inválidas',
          error: 'Contraseña incorrecta'
        });
      }

      // Validaciones específicas por tipo de usuario
      if (userType === 'nutriologo') {
        if (user.verificado === 'pendiente') {
          return res.status(403).json({
            success: false,
            message: 'Solicitud de registro aún no ha sido aprobada. Intenta más tarde.',
            error: 'Solicitud de registro aún no ha aprobada. Intenta más tarde.'
          });
        }
        
        if (user.verificado === 'denegado') {
          return res.status(403).json({
            success: false,
            message: 'Solicitud de registro denegada. Si crees que se trata de un error favor de comunicarse con soporte através de nutralis@gmail.com',
            error: 'Solicitud de registro denegada. Si crees que se trata de un error favor de comunicarse con soporte através de nutralis@gmail.com'
          });
        }

        if (user.token) {
          return res.status(403).json({
            success: false,
            message: 'Sesión ya activa en otro dispositivo',
            error: 'Sesión ya activa'
          });
        }

        if (!user.activo) {
          return res.status(401).json({
            success: false,
            message: 'Cuenta desactivada'
          });
        }
      }

      if ((userType === 'nutriologo' || userType === 'cliente') && !user.tiene_acceso) {
        return res.status(401).json({
          success: false,
          message: 'Sin acceso al sistema. Contacta al administrador.',
          needsPayment: true
        });
      }

      // Generar token para web (nutriólogos y admins)
      let newToken = null;
      if (userType === 'nutriologo' || userType === 'admin') {
        newToken = uuidv4();
        
        const tabla = userType === 'admin' ? 'administradores' : 'nutriologos';
        const campo = userType === 'admin' ? 'id_admin' : 'id_nut';
        
        connection.query(
          `UPDATE ${tabla} SET token = ? WHERE ${campo} = ?`,
          [newToken, user.id],
          (err) => {
            if (err) console.error('Error guardando token:', err);
          }
        );
      }

      const userData = { ...user };
      delete userData.password;
      delete userData.token;

      // Respuesta unificada
      const response = {
        success: true,
        message: 'Login exitoso',
        user: {
          ...userData,
          userType
        }
      };

      // Agregar campos específicos para web
      if (userType === 'nutriologo' || userType === 'admin') {
        response.id_nut = user.id;
        response.nombre = userData.nombre;
        response.token = newToken;
        response.tipo_usu = userData.tipo_usu;
        response.rol = userType;
      }

      res.json(response);

    } catch (dbError) {
      console.error('Error de base de datos:', dbError);
      return res.status(500).json({
        success: false,
        message: 'Error en el servidor'
      });
    }

  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// LOGIN GOOGLE para nutriólogos (WEB)
app.post('/api/nutriologos/login-google', (req, res) => {
  const { correo, nombre } = req.body;
  if (!correo) return res.status(400).json({ error: 'Correo requerido' });

  const sqlNutri = `SELECT id_nut AS id, nombre_nut AS nombre, token, verificado, tiene_acceso, tipo_usu FROM nutriologos WHERE correo = ?`;

  connection.query(sqlNutri, [correo], (err, results) => {
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
      connection.query(`UPDATE nutriologos SET token = ? WHERE id_nut = ?`, [newToken, nutri.id], (err2) => {
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
      res.status(404).json({ error: 'Usuario no registrado, favor registrarse' });
    }
  });
});

// LOGOUT UNIFICADO
app.post('/api/logout', (req, res) => {
  const { id, rol } = req.body;

  // Para móvil (respuesta simple)
  if (!id && !rol) {
    return res.json({
      success: true,
      message: 'Sesión cerrada exitosamente',
      redirect: '/login',
      timestamp: new Date().toISOString()
    });
  }

  // Para web (con actualización de token)
  if (!id || !rol) {
    return res.status(400).json({ error: 'Datos incompletos para cerrar sesión' });
  }

  const tabla = rol === 'admin' ? 'administradores' : 'nutriologos';
  const campo = rol === 'admin' ? 'id_admin' : 'id_nut';

  connection.query(
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

// REGISTRO CLIENTE (MÓVIL)
app.post('/api/register-client', async (req, res) => {
  try {
    const {
      nombre_cli, app_cli, apm_cli, correo_cli, password_cli,
      edad_cli, sexo_cli, peso_cli, estatura_cli, faf_cli, geb_cli, modo
    } = req.body;

    if (!nombre_cli || !app_cli || !apm_cli || !correo_cli || !password_cli || 
        !edad_cli || !sexo_cli || !peso_cli || !estatura_cli) {
      return res.status(400).json({
        success: false,
        message: 'Todos los campos obligatorios son requeridos'
      });
    }

    const connection = await mysql.createConnection(dbConfig);

    try {
      const [existingUser] = await connection.execute(
        'SELECT correo_cli FROM clientes WHERE correo_cli = ?',
        [correo_cli]
      );

      if (existingUser.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Este correo electrónico ya está registrado'
        });
      }

      const [result] = await connection.execute(
        `INSERT INTO clientes (
          nombre_cli, app_cli, apm_cli, correo_cli, password_cli, 
          edad_cli, sexo_cli, peso_cli, estatura_cli, faf_cli, geb_cli, 
          modo, tiene_acceso
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
        [
          nombre_cli, app_cli, apm_cli, correo_cli, password_cli,
          edad_cli, sexo_cli, peso_cli, estatura_cli, faf_cli || 1.2, geb_cli || 0,
          modo || 'autonomo'
        ]
      );

      res.json({
        success: true,
        message: 'Cliente registrado exitosamente.',
        clientId: result.insertId,
        needsPayment: false
      });

    } finally {
      await connection.end();
    }

  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

// REGISTRO NUTRIÓLOGO (WEB)
app.post('/api/nutriologos/registro', async (req, res) => {
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

    connection.query(
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

// =============================================================================
// ENDPOINTS MERCADO PAGO (MÓVIL)
// =============================================================================

app.post('/api/mercadopago/create-preference', async (req, res) => {
  try {
    const { 
      title, 
      price, 
      quantity = 1, 
      currency_id = 'MXN',
      user_id,
      user_email,
      plan_type 
    } = req.body;

    console.log('💳 Creando preferencia de pago:', { title, price, user_email, plan_type });

    if (!title || !price || !user_email) {
      return res.status(400).json({
        success: false,
        message: 'Faltan datos requeridos: title, price, user_email'
      });
    }

    const preferenceData = {
      items: [
        {
          title: title,
          unit_price: parseFloat(price),
          quantity: parseInt(quantity),
          currency_id: currency_id
        }
      ],
      payer: {
        email: user_email,
        ...(user_id && { external_reference: user_id.toString() })
      },
      back_urls: {
        success: 'https://nutweb.onrender.com/payment/success',
        failure: 'https://nutweb.onrender.com/payment/failure',
        pending: 'https://nutweb.onrender.com/payment/pending'
      },
      auto_return: 'approved',
      external_reference: JSON.stringify({
        user_id: user_id,
        plan_type: plan_type,
        timestamp: new Date().toISOString()
      }),
      statement_descriptor: 'NUTRALIS',
      expires: true,
      expiration_date_from: new Date().toISOString(),
      expiration_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    };

    const result = await preference.create({ body: preferenceData });
    
    console.log('✅ Preferencia creada:', result.id);

    res.json({
      success: true,
      preference_id: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point,
      payment_data: {
        preference_id: result.id,
        collector_id: result.collector_id
      }
    });

  } catch (error) {
    console.error('❌ Error creando preferencia MP:', error);
    res.status(500).json({
      success: false,
      message: 'Error creando preferencia de pago',
      error: error.message
    });
  }
});

app.get('/payment/success', async (req, res) => {
  try {
    const {
      collection_id,
      collection_status,
      payment_id,
      status,
      external_reference,
      payment_type,
      merchant_order_id,
      preference_id
    } = req.query;

    console.log('✅ Pago exitoso recibido:', {
      payment_id,
      status,
      external_reference
    });

    let referenceData = {};
    try {
      referenceData = JSON.parse(decodeURIComponent(external_reference));
    } catch (e) {
      console.log('⚠️ No se pudo parsear external_reference:', external_reference);
    }

    const { user_id, plan_type } = referenceData;
    let subscriptionToken = null;

    if (user_id && status === 'approved') {
      try {
        const connection = await mysql.createConnection(dbConfig);
        
        const updateQuery = `
          UPDATE clientes 
          SET tiene_acceso = TRUE, fecha_pago = NOW() 
          WHERE id_cli = ?
        `;
        
        await connection.execute(updateQuery, [user_id]);
        
        subscriptionToken = generateSubscriptionToken(user_id, plan_type, payment_id);
        await saveSubscriptionToken(user_id, subscriptionToken, payment_id, plan_type);
        
        try {
          await connection.execute(
            `INSERT INTO pagos_registrados 
             (user_id, plan_type, monto, moneda, payment_id, estado, fecha_pago) 
             VALUES (?, ?, ?, ?, ?, 'approved', NOW())`,
            [user_id, plan_type || 'cliente', 99.00, 'MXN', payment_id]
          );
        } catch (insertError) {
          console.log('⚠️ No se pudo registrar el pago (tabla no existe):', insertError.message);
        }
        
        await connection.end();
        
        console.log(`✅ Acceso activado para usuario ${user_id}`);
        console.log(`🎫 Token generado: ${subscriptionToken}`);
      } catch (dbError) {
        console.error('❌ Error actualizando BD:', dbError);
      }
    }

    const successHTML = `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Pago Exitoso - Nutralis</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                background: linear-gradient(135deg, #7A9B57, #5a7a42);
                margin: 0;
                padding: 20px;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
            }
            .container {
                background: white;
                border-radius: 20px;
                padding: 40px;
                text-align: center;
                box-shadow: 0 10px 30px rgba(0,0,0,0.3);
                max-width: 450px;
                width: 100%;
            }
            .success-icon {
                font-size: 60px;
                color: #28a745;
                margin-bottom: 20px;
            }
            .title {
                color: #333;
                font-size: 24px;
                font-weight: bold;
                margin-bottom: 15px;
            }
            .message {
                color: #666;
                font-size: 16px;
                margin-bottom: 30px;
                line-height: 1.5;
            }
            .payment-details {
                background: #f8f9fa;
                border-radius: 10px;
                padding: 20px;
                margin-bottom: 30px;
                text-align: left;
            }
            .detail-row {
                display: flex;
                justify-content: space-between;
                margin-bottom: 10px;
                font-size: 14px;
            }
            .detail-label {
                font-weight: bold;
                color: #333;
            }
            .detail-value {
                color: #666;
            }
            .token-section {
                background: #e8f5e8;
                border: 2px solid #7A9B57;
                border-radius: 10px;
                padding: 20px;
                margin-bottom: 30px;
                text-align: center;
            }
            .token-title {
                color: #7A9B57;
                font-size: 18px;
                font-weight: bold;
                margin-bottom: 10px;
            }
            .token-value {
                background: white;
                border: 1px solid #7A9B57;
                border-radius: 8px;
                padding: 15px;
                font-size: 20px;
                font-weight: bold;
                color: #333;
                letter-spacing: 1px;
                margin-bottom: 15px;
                word-break: break-all;
            }
            .copy-button {
                background: #7A9B57;
                color: white;
                border: none;
                padding: 10px 20px;
                border-radius: 5px;
                cursor: pointer;
                font-size: 14px;
                margin-top: 10px;
            }
            .copy-button:hover {
                background: #5a7a42;
            }
            .instructions {
                margin-top: 20px;
                padding: 15px;
                background: #e7f3ff;
                border-radius: 8px;
                font-size: 14px;
                color: #0066cc;
                text-align: left;
            }
            .return-button {
                background: #7A9B57;
                color: white;
                border: none;
                padding: 15px 30px;
                border-radius: 8px;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                text-decoration: none;
                display: inline-block;
                transition: background 0.3s;
            }
            .return-button:hover {
                background: #5a7a42;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="success-icon">✅</div>
            <h1 class="title">¡Pago Exitoso!</h1>
            <p class="message">
                Tu pago ha sido procesado correctamente. Ya tienes acceso completo a Nutralis.
            </p>
            
            <div class="payment-details">
                <div class="detail-row">
                    <span class="detail-label">ID de Pago:</span>
                    <span class="detail-value">${payment_id}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Estado:</span>
                    <span class="detail-value">${status === 'approved' ? 'Aprobado' : status}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Método:</span>
                    <span class="detail-value">${payment_type === 'debit_card' ? 'Tarjeta de Débito' : payment_type}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Plan:</span>
                    <span class="detail-value">Cliente Mensual - $99 MXN</span>
                </div>
            </div>
            
            ${subscriptionToken ? `
            <div class="token-section">
                <div class="token-title">🎫 Token de Suscripción</div>
                <div class="token-value" id="tokenValue">${subscriptionToken}</div>
                <button class="copy-button" onclick="copyToken()">📋 Copiar Token</button>
                <div style="margin-top: 10px; font-size: 12px; color: #666;">
                    Usa este token en la app para activar tu suscripción
                </div>
            </div>
            ` : ''}
            
            <div class="instructions">
                <strong>Instrucciones:</strong><br>
                1. <strong>Copia el token de suscripción</strong> (botón de arriba)<br>
                2. <strong>Regresa a la app Nutralis</strong><br>
                3. <strong>Ingresa el token</strong> en la pantalla de verificación<br>
                4. <strong>¡Disfruta de tu acceso completo!</strong>
            </div>
            
            <a href="#" class="return-button" onclick="window.close()">
                Cerrar Ventana
            </a>
        </div>
        
        <script>
            function copyToken() {
                const tokenValue = document.getElementById('tokenValue').textContent;
                
                if (navigator.clipboard) {
                    navigator.clipboard.writeText(tokenValue).then(() => {
                        const button = document.querySelector('.copy-button');
                        const originalText = button.textContent;
                        button.textContent = '✅ Copiado!';
                        button.style.background = '#28a745';
                        
                        setTimeout(() => {
                            button.textContent = originalText;
                            button.style.background = '#7A9B57';
                        }, 2000);
                    }).catch(err => {
                        console.error('Error copiando:', err);
                        fallbackCopyToken(tokenValue);
                    });
                } else {
                    fallbackCopyToken(tokenValue);
                }
            }
            
            function fallbackCopyToken(text) {
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.left = '-999999px';
                textArea.style.top = '-999999px';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                
                try {
                    document.execCommand('copy');
                    const button = document.querySelector('.copy-button');
                    button.textContent = '✅ Copiado!';
                    button.style.background = '#28a745';
                    
                    setTimeout(() => {
                        button.textContent = '📋 Copiar Token';
                        button.style.background = '#7A9B57';
                    }, 2000);
                } catch (err) {
                    console.error('Error copiando:', err);
                    alert('Token: ' + text);
                }
                
                document.body.removeChild(textArea);
            }
            
            setTimeout(() => {
                try {
                    window.close();
                } catch (e) {
                    console.log('No se puede cerrar la ventana automáticamente');
                }
            }, 30000);
        </script>
    </body>
    </html>
    `;

    res.send(successHTML);

  } catch (error) {
    console.error('❌ Error en payment/success:', error);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h2>Error procesando el pago</h2>
          <p>Tu pago fue procesado, pero hubo un error en nuestro servidor.</p>
          <p>Por favor, contacta a soporte.</p>
        </body>
      </html>
    `);
  }
});

app.get('/payment/failure', (req, res) => {
  const { payment_id, status, external_reference } = req.query;
  
  console.log('❌ Pago fallido:', { payment_id, status, external_reference });

  const failureHTML = `
  <!DOCTYPE html>
  <html lang="es">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Pago Fallido - Nutralis</title>
      <style>
          body {
              font-family: Arial, sans-serif;
              background: linear-gradient(135deg, #dc3545, #c82333);
              margin: 0;
              padding: 20px;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
          }
          .container {
              background: white;
              border-radius: 20px;
              padding: 40px;
              text-align: center;
              box-shadow: 0 10px 30px rgba(0,0,0,0.3);
              max-width: 400px;
              width: 100%;
          }
          .error-icon {
              font-size: 60px;
              color: #dc3545;
              margin-bottom: 20px;
          }
          .title {
              color: #333;
              font-size: 24px;
              font-weight: bold;
              margin-bottom: 15px;
          }
          .message {
              color: #666;
              font-size: 16px;
              margin-bottom: 30px;
              line-height: 1.5;
          }
          .retry-button {
              background: #7A9B57;
              color: white;
              border: none;
              padding: 15px 30px;
              border-radius: 8px;
              font-size: 16px;
              font-weight: bold;
              cursor: pointer;
              text-decoration: none;
              display: inline-block;
              margin-right: 10px;
              transition: background 0.3s;
          }
          .retry-button:hover {
              background: #5a7a42;
          }
          .close-button {
              background: #6c757d;
              color: white;
              border: none;
              padding: 15px 30px;
              border-radius: 8px;
              font-size: 16px;
              cursor: pointer;
              text-decoration: none;
              display: inline-block;
              transition: background 0.3s;
          }
          .close-button:hover {
              background: #5a6268;
          }
      </style>
  </head>
  <body>
      <div class="container">
          <div class="error-icon">❌</div>
          <h1 class="title">Pago No Procesado</h1>
          <p class="message">
              Tu pago no pudo ser procesado. No se realizó ningún cargo.
          </p>
          
          <div style="margin-top: 30px;">
              <a href="#" class="retry-button" onclick="window.close()">
                  Volver a Intentar
              </a>
              <a href="#" class="close-button" onclick="window.close()">
                  Cerrar
              </a>
          </div>
      </div>
  </body>
  </html>
  `;

  res.send(failureHTML);
});

app.get('/payment/pending', (req, res) => {
  const { payment_id, status, external_reference } = req.query;
  
  console.log('⏳ Pago pendiente:', { payment_id, status, external_reference });

  const pendingHTML = `
  <!DOCTYPE html>
  <html lang="es">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Pago Pendiente - Nutralis</title>
      <style>
          body {
              font-family: Arial, sans-serif;
              background: linear-gradient(135deg, #ffc107, #e0a800);
              margin: 0;
              padding: 20px;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
          }
          .container {
              background: white;
              border-radius: 20px;
              padding: 40px;
              text-align: center;
              box-shadow: 0 10px 30px rgba(0,0,0,0.3);
              max-width: 400px;
              width: 100%;
          }
          .pending-icon {
              font-size: 60px;
              color: #ffc107;
              margin-bottom: 20px;
          }
          .title {
              color: #333;
              font-size: 24px;
              font-weight: bold;
              margin-bottom: 15px;
          }
          .message {
              color: #666;
              font-size: 16px;
              margin-bottom: 30px;
              line-height: 1.5;
          }
          .info-box {
              background: #fff3cd;
              border: 1px solid #ffeaa7;
              border-radius: 8px;
              padding: 15px;
              margin-bottom: 20px;
              font-size: 14px;
              color: #856404;
          }
          .close-button {
              background: #7A9B57;
              color: white;
              border: none;
              padding: 15px 30px;
              border-radius: 8px;
              font-size: 16px;
              cursor: pointer;
              text-decoration: none;
              display: inline-block;
              transition: background 0.3s;
          }
          .close-button:hover {
              background: #5a7a42;
          }
      </style>
  </head>
  <body>
      <div class="container">
          <div class="pending-icon">⏳</div>
          <h1 class="title">Pago Pendiente</h1>
          <p class="message">
              Tu pago está siendo procesado. Te notificaremos cuando se complete.
          </p>
          
          <div class="info-box">
              <strong>ID de Pago:</strong> ${payment_id || 'N/A'}<br>
              <strong>Estado:</strong> ${status || 'Pendiente'}
          </div>
          
          <a href="#" class="close-button" onclick="window.close()">
              Cerrar Ventana
          </a>
      </div>
  </body>
  </html>
  `;

  res.send(pendingHTML);
});

app.post('/api/verify-subscription-token', async (req, res) => {
  try {
    const { token, userId } = req.body;
    
    if (!token || !userId) {
      return res.status(400).json({
        success: false,
        message: 'Token y ID de usuario son requeridos'
      });
    }
    
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [tokenRows] = await connection.execute(
        `SELECT * FROM subscription_tokens 
         WHERE token = ? AND user_id = ? AND status = 'active' AND expires_at > NOW()`,
        [token, userId]
      );
      
      if (tokenRows.length === 0) {
        return res.json({
          success: false,
          message: 'Token inválido, expirado o ya usado'
        });
      }
      
      const tokenData = tokenRows[0];
      
      await connection.execute(
        `UPDATE subscription_tokens 
         SET status = 'used', used_at = NOW() 
         WHERE id = ?`,
        [tokenData.id]
      );
      
      await connection.execute(
        `UPDATE clientes 
         SET tiene_acceso = TRUE, fecha_pago = NOW() 
         WHERE id_cli = ?`,
        [userId]
      );
      
      console.log(`✅ Token usado exitosamente: ${token} para usuario ${userId}`);
      
      res.json({
        success: true,
        message: 'Token verificado exitosamente. Acceso activado.',
        plan_type: tokenData.plan_type,
        activated_at: new Date().toISOString()
      });
      
    } finally {
      await connection.end();
    }
    
  } catch (error) {
    console.error('❌ Error verificando token:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

app.get('/api/mercadopago/plans', (req, res) => {
  const plans = [
    {
      id: 'cliente_mensual',
      name: 'Plan Cliente Mensual',
      description: 'Acceso completo a la app móvil por 1 mes',
      price: 99.00,
      currency: 'MXN',
      duration: '1 mes',
      features: [
        'Registro de comidas',
        'Seguimiento nutricional',
        'Estadísticas personales',
        'Báscula inteligente'
      ]
    },
    {
      id: 'nutriologo_mensual',
      name: 'Plan Nutriólogo Mensual',
      description: 'Acceso al panel web para nutriólogos por 1 mes',
      price: 299.00,
      currency: 'MXN',
      duration: '1 mes',
      features: [
        'Panel de administración',
        'Gestión de clientes',
        'Reportes detallados',
        'Comunicación con clientes'
      ]
    }
  ];

  res.json({
    success: true,
    plans: plans
  });
});

// =============================================================================
// ENDPOINTS PAYPAL (WEB)
// =============================================================================

app.post('/api/crear-pago', async (req, res) => {
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
app.post('/api/capturar-pago', async (req, res) => {
  const { orderID, id_pago } = req.body;

  if (!orderID || !id_pago) {
    return res.status(400).json({ 
      success: false,
      error: 'Faltan datos requeridos: orderID e id_pago' 
    });
  }

  console.log('💳 Capturando pago PayPal:', { orderID, id_pago });

  try {
    // Obtener token de PayPal
    const token = await getPayPalToken();

    // Capturar el pago en PayPal
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

    console.log('📊 Respuesta de PayPal:', captureResponse.data);

    // Determinar el estado del pago
    let estado = 'fallido';
    if (captureResponse.data.status === 'COMPLETED') {
      estado = 'exitoso';
    } else if (captureResponse.data.status === 'PENDING') {
      estado = 'pendiente';
    }

    console.log('📈 Estado del pago determinado:', estado);

    // Actualizar el estado del pago en la base de datos
    const [updateResult] = await pool.execute(
      'UPDATE pagos_nutriologos SET estado = ?, fecha_captura = NOW() WHERE id_pago = ?',
      [estado, id_pago]
    );

    if (updateResult.affectedRows === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Pago no encontrado en la base de datos' 
      });
    }

    console.log('✅ Estado del pago actualizado en BD');

    // Si el pago fue exitoso, activar la suscripción del nutriólogo
    if (estado === 'exitoso') {
      try {
        // Obtener información del pago
        const [pagoRows] = await pool.execute(
          'SELECT fecha_pago, id_nut, monto FROM pagos_nutriologos WHERE id_pago = ?',
          [id_pago]
        );

        if (pagoRows.length === 0) {
          throw new Error('No se encontraron datos del pago');
        }

        const { fecha_pago, id_nut, monto } = pagoRows[0];

        console.log('👤 Activando suscripción para nutriólogo:', { id_nut, monto });

        // Calcular fecha de fin de suscripción (30 días después)
        const fechaInicio = new Date(fecha_pago);
        const fechaFin = new Date(fechaInicio);
        fechaFin.setDate(fechaFin.getDate() + 30); // 30 días de suscripción

        // Actualizar la información del nutriólogo
        const [nutriologoResult] = await pool.execute(
          `UPDATE nutriologos 
           SET fecha_inicio_sub = ?, 
               fecha_fin_sub = ?, 
               tiene_acceso = 1, 
               activo = 1 
           WHERE id_nut = ?`,
          [fechaInicio.toISOString().split('T')[0], fechaFin.toISOString().split('T')[0], id_nut]
        );

        if (nutriologoResult.affectedRows === 0) {
          console.error('⚠️ No se pudo actualizar el nutriólogo:', id_nut);
        } else {
          console.log('✅ Suscripción activada exitosamente');
        }

        // Opcional: Crear registro en tabla de suscripciones si existe
        try {
          await pool.execute(
            `INSERT INTO suscripciones_nutriologos 
             (id_nut, id_pago, fecha_inicio, fecha_fin, monto, estado, metodo_pago) 
             VALUES (?, ?, ?, ?, ?, 'activa', 'paypal')
             ON DUPLICATE KEY UPDATE 
             fecha_fin = VALUES(fecha_fin), 
             estado = VALUES(estado)`,
            [id_nut, id_pago, fechaInicio.toISOString().split('T')[0], fechaFin.toISOString().split('T')[0], monto]
          );
          console.log('📝 Registro de suscripción creado/actualizado');
        } catch (subscriptionError) {
          console.log('⚠️ No se pudo crear registro de suscripción (tabla no existe):', subscriptionError.message);
        }

        res.json({
          success: true,
          mensaje: 'Pago capturado y suscripción activada exitosamente',
          estado: estado,
          pago_id: id_pago,
          orden_paypal: orderID,
          nutriologo_id: id_nut,
          fecha_inicio_sub: fechaInicio.toISOString().split('T')[0],
          fecha_fin_sub: fechaFin.toISOString().split('T')[0],
          detalle: {
            paypal_status: captureResponse.data.status,
            paypal_id: captureResponse.data.id,
            amount: captureResponse.data.purchase_units?.[0]?.payments?.captures?.[0]?.amount
          }
        });

      } catch (subscriptionError) {
        console.error('❌ Error activando suscripción:', subscriptionError);
        
        // Aunque falle la activación, el pago fue exitoso
        res.json({
          success: true,
          mensaje: 'Pago capturado exitosamente, pero hubo un error activando la suscripción',
          estado: estado,
          pago_id: id_pago,
          orden_paypal: orderID,
          error_suscripcion: subscriptionError.message,
          detalle: captureResponse.data
        });
      }
    } else {
      // Pago no exitoso
      res.json({
        success: false,
        mensaje: `Pago ${estado}`,
        estado: estado,
        pago_id: id_pago,
        orden_paypal: orderID,
        detalle: captureResponse.data
      });
    }

  } catch (error) {
    console.error('❌ Error al capturar pago PayPal:', error);
    
    // Verificar si el error es de PayPal o de base de datos
    if (error.response?.data) {
      console.error('📊 Detalles del error de PayPal:', error.response.data);
      res.status(400).json({ 
        success: false,
        error: 'Error en PayPal', 
        detalle: error.response.data,
        codigo_error: error.response.status 
      });
    } else {
      res.status(500).json({ 
        success: false,
        error: 'Error interno del servidor', 
        detalle: error.message 
      });
    }
  }
});

// =============================================================================
// MANEJO DE ERRORES Y INICIO DEL SERVIDOR
// =============================================================================

// Manejo de errores globales
app.use((error, req, res, next) => {
  console.error('❌ Error global:', error);
  res.status(500).json({
    success: false,
    message: 'Error interno del servidor',
    error: error.message
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📡 API disponible en: http://localhost:${PORT}/api`);
  console.log(`❤️ Health check: http://localhost:${PORT}/health`);
  console.log(`📟 WebSocket para báscula en puerto 8080`);
  console.log('');
  console.log('🔧 Servicios disponibles:');
  console.log('   ✅ MySQL/MariaDB - Comidas principales');
  console.log('   ✅ MongoDB - Detalles nutricionales');
  console.log('   ✅ WebSocket IoT - Báscula inteligente');
  console.log('   ✅ API REST - Gestión completa');
  console.log('');
  console.log('📋 Endpoints principales:');
  console.log('   POST /api/comidas - Guardar en MariaDB');
  console.log('   POST /api/comidas/mongo - Guardar en MongoDB');
  console.log('   GET  /api/comidas/weekly/:id - Resumen semanal');
  console.log('   GET  /api/comidas/daily/:id - Datos por hora');
  console.log('   GET  /api/iot/scale/status - Estado báscula');
  console.log('   POST /api/iot/scale/send - Enviar a báscula');
});

// Manejar cierre graceful
process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando servidor...');
  if (mongoClient) {
    mongoClient.close();
  }
  process.exit(0);
});