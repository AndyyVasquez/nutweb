require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const WebSocket = require('ws');

const app = express();

// Configuración de CORS
app.use(cors({
  origin: [
    'http://localhost:3000', 
    'http://127.0.0.1:3000',
    'http://localhost:8081',
    'http://127.0.0.1:8081',
    'http://localhost:19006',
    'http://192.168.1.66:8081',
    'http://10.13.8.70:8081',
    'https://nutweb.onrender.com'  // <--- agrega tu dominio de Render
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
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

// Configuración MongoDB Atlas desde .env
const mongoUrl = process.env.MONGO_URI;
const mongoDbName = process.env.MONGO_DB;

// Pool de conexiones MySQL
const pool = mysql.createPool(dbConfig);

// Cliente MongoDB
let mongoClient;
let mongoDB;

// Conectar a MongoDB
const connectMongo = async () => {
  try {
    mongoClient = new MongoClient(mongoUrl, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    await mongoClient.connect();
    mongoDB = mongoClient.db(mongoDbName);
    console.log('✅ Conectado a MongoDB Atlas');
  } catch (error) {
    console.error('❌ Error conectando a MongoDB:', error);
  }
};

// Inicializar MongoDB
connectMongo();


// =============================================================================
// CONFIGURACIÓN IOT - BÁSCULA INTELIGENTE Y PODÓMETRO
// =============================================================================

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

// WebSocket server para comunicación en tiempo real con dispositivos IoT
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

// Función para guardar pasos en base de datos (MySQL + MongoDB)
const saveStepsToDatabase = async (steps, userId = null) => {
  try {
    if (!userId) {
      console.log('⚠️ No se especificó usuario para guardar pasos');
      return;
    }
    
    const today = new Date().toISOString().split('T')[0];
    const hora = new Date().toTimeString().split(' ')[0];
    
    // === GUARDAR EN MYSQL (actividad_fisica) ===
    const checkQuery = `
      SELECT id_actividad FROM actividad_fisica 
      WHERE id_cli = ? AND fecha = ? AND tipo_actividad = 'pasos'
    `;
    
    const [existingRows] = await pool.execute(checkQuery, [userId, today]);
    
    if (existingRows.length > 0) {
      // Actualizar registro existente en MySQL
      const updateQuery = `
        UPDATE actividad_fisica 
        SET pasos_totales = ?, hora_actualizacion = ?, last_update = NOW()
        WHERE id_cli = ? AND fecha = ? AND tipo_actividad = 'pasos'
      `;
      
      await pool.execute(updateQuery, [steps, hora, userId, today]);
      console.log(`👟 Pasos actualizados en MySQL: ${steps} para usuario ${userId}`);
    } else {
      // Crear nuevo registro en MySQL
      const insertQuery = `
        INSERT INTO actividad_fisica 
        (id_cli, fecha, hora_actualizacion, tipo_actividad, pasos_totales, calorias_quemadas, last_update) 
        VALUES (?, ?, ?, 'pasos', ?, ?, NOW())
      `;
      
      // Estimación básica: 1 paso ≈ 0.04 calorías
      const caloriasEstimadas = Math.round(steps * 0.04);
      
      await pool.execute(insertQuery, [userId, today, hora, steps, caloriasEstimadas]);
      console.log(`👟 Nuevo registro de pasos en MySQL: ${steps} para usuario ${userId}`);
    }

    // === GUARDAR EN MONGODB ===
    if (mongoDB) {
      try {
        const collection = mongoDB.collection('actividad_pasos');
        
        // Buscar si ya existe registro para hoy
        const existingDoc = await collection.findOne({
          id_cli: parseInt(userId),
          fecha: today
        });

        const caloriasGastadas = Math.round(steps * 0.04);
        const distanciaKm = (steps * 0.75 / 1000).toFixed(2); // Estimación: 75cm por paso
        
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
          // Actualizar documento existente
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
          // Crear nuevo documento
          const result = await collection.insertOne(documentoMongo);
          console.log(`👟 Nuevo registro de pasos en MongoDB: ${steps}, ID: ${result.insertedId}`);
        }

      } catch (mongoError) {
        console.error('❌ Error guardando en MongoDB:', mongoError);
      }
    } else {
      console.log('⚠️ MongoDB no disponible para guardar pasos');
    }
    
  } catch (error) {
    console.error('❌ Error guardando pasos en BD:', error);
  }
};

// =============================================================================
// ENDPOINTS PRINCIPALES
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

// Endpoints de prueba
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

// =============================================================================
// ENDPOINTS DE COMIDAS - INTEGRACIÓN DUAL BD
// =============================================================================

// POST /api/comidas - Guardar en MariaDB
app.post('/api/comidas', async (req, res) => {
  try {
    const { id_cli, fecha, hora, calorias_totales, grupo_alimenticio, mensaje_validacion } = req.body;

    console.log('📝 Guardando comida en MariaDB:', req.body);

    // Validar datos requeridos
    if (!id_cli || !fecha || !hora || !calorias_totales || !grupo_alimenticio) {
      return res.status(400).json({
        success: false,
        message: 'Faltan datos requeridos'
      });
    }

    // Insertar en MariaDB
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

    // Validar datos requeridos
    if (!id_cli || !id_comida || !nombre_alimento) {
      return res.status(400).json({
        success: false,
        message: 'Faltan datos requeridos para MongoDB'
      });
    }

    // Verificar conexión MongoDB
    if (!mongoDB) {
      throw new Error('MongoDB no está conectado');
    }

    // Preparar documento para MongoDB con validación de tipos
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

    // Procesar información nutricional con validación
    if (informacion_nutricional && typeof informacion_nutricional === 'object') {
      documento.informacion_nutricional = {
        proteinas: parseFloat(informacion_nutricional.proteinas) || 0,
        carbohidratos: parseFloat(informacion_nutricional.carbohidratos) || 0,
        grasas: parseFloat(informacion_nutricional.grasas) || 0,
        fibra: parseFloat(informacion_nutricional.fibra) || 0
      };

      // Solo agregar nutriscore si existe y es válido
      if (informacion_nutricional.nutriscore && 
          typeof informacion_nutricional.nutriscore === 'string' && 
          informacion_nutricional.nutriscore.length > 0) {
        documento.informacion_nutricional.nutriscore = informacion_nutricional.nutriscore;
      }

      // Solo agregar novaGroup si existe y es un número válido
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

    // Insertar en MongoDB
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

// GET /api/comidas/stats/:id_cli - Obtener estadísticas detalladas
app.get('/api/comidas/stats/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const { dias = 7 } = req.query; // Por defecto últimos 7 días

    // Obtener estadísticas de los últimos N días
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

    // Obtener totales generales
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

// GET /api/comidas/weekly/:id_cli - Obtener resumen semanal específico
app.get('/api/comidas/weekly/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    
    console.log('📅 Obteniendo resumen semanal para cliente:', id_cli);
    
    // Calcular el lunes de esta semana
    const today = new Date();
    const currentDay = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - (currentDay === 0 ? 6 : currentDay - 1));

    // Generar las 7 fechas de la semana
    const weekDates = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      weekDates.push(date.toISOString().split('T')[0]);
    }

    console.log('📅 Fechas de la semana calculadas:', weekDates);

    // Consulta simple que agrupa por fecha
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

    // Mapear resultados a días de la semana
    const weeklyData = {
      lunes: 0, martes: 0, miercoles: 0, jueves: 0, 
      viernes: 0, sabado: 0, domingo: 0
    };

    const dayNames = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
    
    // Procesar cada fila
    rows.forEach((row) => {
      // Convertir fecha de BD a string YYYY-MM-DD
      let fechaRow;
      if (row.fecha_formateada instanceof Date) {
        fechaRow = row.fecha_formateada.toISOString().split('T')[0];
      } else {
        fechaRow = row.fecha_formateada;
      }
      
      console.log(`📅 Procesando fecha: ${fechaRow} con ${row.calorias_dia} calorías`);
      
      // Buscar esta fecha en las fechas de la semana
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

// GET /api/comidas/daily/:id_cli - Obtener consumo por horas del día
app.get('/api/comidas/daily/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const { fecha } = req.query;
    const targetDate = fecha || new Date().toISOString().split('T')[0];

    console.log('🕐 Obteniendo consumo diario por horas para cliente:', id_cli, 'fecha:', targetDate);

    // Obtener comidas del día agrupadas por hora
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

    // Crear array de 24 horas (0-23) con datos
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

    // Obtener estadísticas del día
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
        .slice(0, 3) // Top 3 horas con más calorías
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

// GET /api/comidas/summary/:id_cli - Obtener resumen completo del usuario
app.get('/api/comidas/summary/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const today = new Date().toISOString().split('T')[0];

    console.log('📊 Obteniendo resumen completo para cliente:', id_cli, 'fecha:', today);

    // Resumen de hoy
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

    // Estadísticas de la semana
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

    // Estadísticas generales
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

    // Grupos alimentarios más consumidos
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

// GET /api/user/profile/:id_cli - Obtener perfil completo del usuario
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

    // Calcular meta calórica básica usando Harris-Benedict
    let bmr = 0;
    if (usuario.sexo_cli === 'M' || usuario.sexo_cli === 'Masculino') {
      // Hombres: BMR = 88.362 + (13.397 × peso) + (4.799 × altura) - (5.677 × edad)
      bmr = 88.362 + (13.397 * usuario.peso_cli) + (4.799 * usuario.estatura_cli) - (5.677 * usuario.edad_cli);
    } else {
      // Mujeres: BMR = 447.593 + (9.247 × peso) + (3.098 × altura) - (4.330 × edad)
      bmr = 447.593 + (9.247 * usuario.peso_cli) + (3.098 * usuario.estatura_cli) - (4.330 * usuario.edad_cli);
    }

    // Aplicar factor de actividad física
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

// =============================================================================
// ENDPOINTS IOT - BÁSCULA INTELIGENTE Y PODÓMETRO ESP32
// =============================================================================

// GET /api/iot/scale/status - Estado de la báscula
app.get('/api/iot/scale/status', (req, res) => {
  res.json({
    connected: scaleState.connected,
    lastUpdate: scaleState.lastUpdate,
    calibrated: scaleState.calibrated
  });
});

// GET /api/iot/pedometer/status - Estado del podómetro ESP32
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

// POST /api/iot/pedometer/command - Enviar comandos al ESP32
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

    // Preparar comando para el ESP32
    const commandPayload = {
      type: 'pedometer_command',
      command: command, // 'start', 'stop', 'send', 'reset'
      userId: userId,
      timestamp: new Date().toISOString()
    };

    // Enviar comando a todos los clientes WebSocket (ESP32)
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(commandPayload));
      }
    });

    // Actualizar estado local según el comando
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

// GET /api/iot/pedometer/steps/:id_cli - Obtener pasos del usuario desde BD
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

// GET /api/iot/pedometer/steps/mongo/:id_cli - Obtener pasos desde MongoDB
app.get('/api/iot/pedometer/steps/mongo/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const { fecha, dias = 7 } = req.query;

    if (!mongoDB) {
      return res.status(500).json({
        success: false,
        message: 'MongoDB no está disponible'
      });
    }

    console.log('👟 Obteniendo pasos de MongoDB para usuario:', id_cli);

    const collection = mongoDB.collection('actividad_pasos');
    
    if (fecha) {
      // Obtener datos de una fecha específica
      const documento = await collection.findOne({
        id_cli: parseInt(id_cli),
        fecha: fecha
      });

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
    } else {
      // Obtener datos de los últimos X días
      const fechaInicio = new Date();
      fechaInicio.setDate(fechaInicio.getDate() - parseInt(dias));
      const fechaInicioStr = fechaInicio.toISOString().split('T')[0];

      const documentos = await collection.find({
        id_cli: parseInt(id_cli),
        fecha: { $gte: fechaInicioStr }
      }).sort({ fecha: -1 }).toArray();

      // Calcular estadísticas
      const totalPasos = documentos.reduce((sum, doc) => sum + (doc.pasos || 0), 0);
      const totalCalorias = documentos.reduce((sum, doc) => sum + (doc.calorias_gastadas || 0), 0);
      const totalDistancia = documentos.reduce((sum, doc) => sum + (doc.distancia_km || 0), 0);
      const promedioPasos = documentos.length > 0 ? Math.round(totalPasos / documentos.length) : 0;

      res.json({
        success: true,
        data: documentos,
        estadisticas: {
          dias_consultados: parseInt(dias),
          total_pasos: totalPasos,
          total_calorias: totalCalorias,
          total_distancia_km: totalDistancia.toFixed(2),
          promedio_pasos_dia: promedioPasos,
          dias_activos: documentos.length
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
    
    if (!id_cli || steps === undefined) {
      return res.status(400).json({
        success: false,
        message: 'ID de usuario y pasos son requeridos'
      });
    }

    const targetDate = fecha || new Date().toISOString().split('T')[0];
    
    await saveStepsToDatabase(steps, id_cli);
    
    res.json({
      success: true,
      message: 'Pasos guardados exitosamente',
      steps: steps,
      date: targetDate
    });

  } catch (error) {
    console.error('❌ Error guardando pasos:', error);
    res.status(500).json({
      success: false,
      message: 'Error guardando pasos',
      error: error.message
    });
  }
});

// GET /api/iot/scale/weight - Obtener peso actual
app.get('/api/iot/scale/weight', (req, res) => {
  if (!scaleState.connected) {
    return res.status(400).json({
      success: false,
      message: 'Báscula no conectada'
    });
  }

  // Simular lectura de peso (en producción vendría del dispositivo)
  const simulatedWeight = Math.floor(Math.random() * 500) + 50; // Entre 50g y 550g
  scaleState.weight = simulatedWeight;
  scaleState.lastUpdate = new Date();

  res.json({
    success: true,
    weight: simulatedWeight,
    timestamp: scaleState.lastUpdate
  });
});

// POST /api/iot/scale/send - Enviar datos a la báscula
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

    // Preparar payload para enviar a la báscula
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

// POST /api/iot/scale/calibrate - Calibrar báscula
app.post('/api/iot/scale/calibrate', (req, res) => {
  if (!scaleState.connected) {
    return res.status(400).json({
      success: false,
      message: 'Báscula no conectada'
    });
  }

  // Enviar comando de calibración
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
// ENDPOINTS DE AUTENTICACIÓN
// =============================================================================

app.post('/api/login', async (req, res) => {
  try {
    console.log('=== LOGIN ATTEMPT ===');
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
        'SELECT id_admin as id, tipo_usu, nombre_admin as nombre, correo_admin as correo, password_admin as password FROM administradores WHERE correo_admin = ?',
        [correo]
      );

      if (adminResults.length > 0) {
        user = adminResults[0];
        userType = 'admin';
      }

      // Buscar en nutriólogos
      if (!user) {
        const [nutResults] = await connection.execute(
          'SELECT id_nut as id, tipo_usu, CONCAT(nombre_nut, " ", app_nut, " ", apm_nut) as nombre, correo_nut as correo, password_nut as password, cedula_nut, especialidad_nut, telefono_nut, activo, tiene_acceso FROM nutriologos WHERE correo_nut = ?',
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
          message: 'Credenciales inválidas'
        });
      }

      if (password !== user.password) {
        return res.status(401).json({
          success: false,
          message: 'Credenciales inválidas'
        });
      }

      // Verificar acceso
      if (userType === 'nutriologo' && !user.activo) {
        return res.status(401).json({
          success: false,
          message: 'Cuenta desactivada'
        });
      }

      if ((userType === 'nutriologo' || userType === 'cliente') && !user.tiene_acceso) {
        return res.status(401).json({
          success: false,
          message: 'Sin acceso al sistema. Contacta al administrador.',
          needsPayment: true
        });
      }

      const userData = { ...user };
      delete userData.password;

      res.json({
        success: true,
        message: 'Login exitoso',
        user: {
          ...userData,
          userType
        }
      });

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

app.post('/api/logout', (req, res) => {
  res.json({
    success: true,
    message: 'Sesión cerrada exitosamente',
    redirect: '/login',
    timestamp: new Date().toISOString()
  });
});

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