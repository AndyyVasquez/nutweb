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
  origin: function(origin, callback) {
    // Permitir requests sin origin (Postman, etc.)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
     'https://integradora1.com',
      'https://www.integradora1.com',
      'http://localhost:3000',
      'http://localhost:3001',
      'https://nutweb.onrender.com'
    ];
    
   if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
 
    console.log('❌ Origin no permitido:', origin);
    return callback(new Error('No permitido por CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization',
     'Accept', 
     'Origin', 
    'X-Requested-With',
    'Access-Control-Allow-Origin'
  ],
  credentials: true,
   optionsSuccessStatus: 200
}));

app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(200);
});



//Middleware adicional para headers CORS
 app.use((req, res, next) => {
   res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
   res.header('Access-Control-Allow-Credentials', 'true');
   res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
   res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With');
 
   // Log para debugging
   if (req.method === 'OPTIONS') {
     console.log('🔧 Preflight request from:', req.headers.origin);
   }
 
   next();
 });

app.use(express.json());


app.post('/api/test-cors', (req, res) => {
  console.log('🧪 Test CORS - Origin:', req.headers.origin);
  console.log('🧪 Test CORS - Method:', req.method);
  console.log('🧪 Test CORS - Headers:', req.headers);
  console.log('🧪 Test CORS - Body:', req.body);
  
  res.json({
    success: true,
    message: 'CORS funcionando',
    receivedData: req.body,
    origin: req.headers.origin
  });
});

// Configuración de base de datos MySQL desde .env
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
};

// Estado global de podómetros conectados
let connectedPedometers = new Map();

const mercadopago = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || 'TEST-3273803796754942-071504-bb24735cf345727f37edd8cf177909da-398459562', // Reemplaza con tu token real
  options: {
    timeout: 5000,
    idempotencyKey: 'abc123'
  }
});

const PAYPAL_CLIENT_ID = 'AbCpAHnHhEs2jlbon0p7sX_hfRcdDE2VN0fYKew2TTddKk2kMQB7JI6C7jl2380cg3Rl2BymYKdlxDxT';
const PAYPAL_SECRET = 'EJ9AM55H8UaXTABTPQoNJcQGdU8y1_cHDTxqVk7xmV8LpyEqkdJGbZLCAteJKVQcj2DbA40bNUK5R4oF';

let connectedScales = new Map();
const payment = new Payment(mercadopago);
const preference = new Preference(mercadopago);


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

    // Validar datos requeridos
    if (!title || !price || !user_email) {
      return res.status(400).json({
        success: false,
        message: 'Faltan datos requeridos: title, price, user_email'
      });
    }

    // Crear preferencia de pago
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
     // Cambiar las back_urls del Preference de Mercado Pago
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
      expiration_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 horas
    };

    const result = await preference.create({ body: preferenceData });
    
    console.log('✅ Preferencia creada:', result.id);

    res.json({
      success: true,
      preference_id: result.id,
      init_point: result.init_point, // URL para web
      sandbox_init_point: result.sandbox_init_point, // URL para pruebas
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

// REEMPLAZAR tu ruta /payment/success con esta versión simplificada:
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

    // Parsear external_reference
    let referenceData = {};
    try {
      referenceData = JSON.parse(decodeURIComponent(external_reference));
    } catch (e) {
      console.log('⚠️ No se pudo parsear external_reference:', external_reference);
    }

    const { user_id, plan_type } = referenceData;

    // Actualizar base de datos si tenemos user_id
    if (user_id && status === 'approved') {
      try {
        const connection = await mysql.createConnection(dbConfig);
        
        // Actualizar acceso del usuario
        const updateQuery = `
          UPDATE clientes 
          SET tiene_acceso = TRUE, fecha_pago = NOW() 
          WHERE id_cli = ?
        `;
        
        await connection.execute(updateQuery, [user_id]);
        
        // Registrar el pago
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
      } catch (dbError) {
        console.error('❌ Error actualizando BD:', dbError);
      }
    }

    // Página HTML de éxito SIN TOKEN
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
            
            <a href="#" class="return-button" onclick="window.close()">
                Regresa a la aplicación
            </a>
        </div>
        
        <script>
            // Intentar cerrar la ventana automáticamente después de 30 segundos
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

//verificar token nutriologo
app.post('/api/verify-nutritionist-token', async (req, res) => {
  try {
    const { token, clientId } = req.body;
    
    console.log('🔍 === VERIFICANDO TOKEN DE NUTRIÓLOGO ===');
    console.log('📥 Token recibido:', token);
    console.log('👤 Cliente ID:', clientId);
    
    if (!token || !clientId) {
      return res.status(400).json({
        success: false,
        message: 'Token y ID de cliente son requeridos'
      });
    }
    
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Buscar nutriólogo con ese token
      const [nutriRows] = await connection.execute(
        `SELECT id_nut, CONCAT(nombre_nut, ' ', app_nut, ' ', COALESCE(apm_nut, '')) as name, 
                especialidad_nut, tiene_acceso, activo, verificado
         FROM nutriologos 
         WHERE token_vinculacion = ? AND activo = 1 AND verificado = 'aprobado'`,
        [token.trim().toUpperCase()]
      );
      
      if (nutriRows.length === 0) {
        console.log('❌ Token de nutriólogo no encontrado o inválido');
        return res.json({
          success: false,
          message: 'Token de nutriólogo inválido o nutriólogo no activo'
        });
      }
      
      const nutriologo = nutriRows[0];
      console.log('✅ Nutriólogo encontrado:', nutriologo.name);
      
      // Verificar que el nutriólogo tenga acceso
      if (!nutriologo.tiene_acceso) {
        console.log('❌ Nutriólogo sin acceso');
        return res.json({
          success: false,
          message: 'El nutriólogo no tiene acceso activo al sistema'
        });
      }
      
      // Verificar si el cliente ya está asignado a algún nutriólogo
      const [clientRows] = await connection.execute(
        `SELECT id_nut, CONCAT(nombre_cli, ' ', app_cli) as client_name 
         FROM clientes 
         WHERE id_cli = ?`,
        [clientId]
      );
      
      if (clientRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Cliente no encontrado'
        });
      }
      
      const cliente = clientRows[0];
      
      // Si ya tiene un nutriólogo asignado, preguntar si quiere cambiar
      if (cliente.id_nut && cliente.id_nut !== nutriologo.id_nut) {
        // Obtener nombre del nutriólogo actual
        const [currentNutriRows] = await connection.execute(
          `SELECT CONCAT(nombre_nut, ' ', app_nut) as current_name 
           FROM nutriologos 
           WHERE id_nut = ?`,
          [cliente.id_nut]
        );
        
        const currentNutriName = currentNutriRows[0]?.current_name || 'Nutriólogo anterior';
        
        console.log(`⚠️ Cliente ya tiene nutriólogo: ${currentNutriName}`);
        return res.json({
          success: false,
          message: `Ya estás vinculado con ${currentNutriName}. ¿Deseas cambiar a ${nutriologo.name}?`,
          conflict: true,
          current_nutritionist: currentNutriName,
          new_nutritionist: nutriologo.name,
          new_nutritionist_id: nutriologo.id_nut
        });
      }
      
      // Actualizar cliente con el nuevo nutriólogo
      await connection.execute(
        `UPDATE clientes 
         SET id_nut = ?, modo = 'supervisado' 
         WHERE id_cli = ?`,
        [nutriologo.id_nut, clientId]
      );
      
      console.log(`✅ Cliente ${cliente.client_name} vinculado con nutriólogo ${nutriologo.name}`);
      
      res.json({
        success: true,
        message: `Te has vinculado exitosamente con ${nutriologo.name}`,
        nutritionist: {
          id: nutriologo.id_nut,
          name: nutriologo.name,
          especialidad: nutriologo.especialidad_nut
        },
        client_mode: 'supervisado'
      });
      
    } finally {
      await connection.end();
    }
    
  } catch (error) {
    console.error('❌ Error verificando token de nutriólogo:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

//cambio de nutriologo default por el asignado fisicamente
app.post('/api/confirm-nutritionist-change', async (req, res) => {
  try {
    const { clientId, newNutritionistId, confirm } = req.body;
    
    if (!clientId || !newNutritionistId || confirm !== true) {
      return res.status(400).json({
        success: false,
        message: 'Datos incompletos o confirmación requerida'
      });
    }
    
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Obtener información del nuevo nutriólogo
      const [nutriRows] = await connection.execute(
        `SELECT CONCAT(nombre_nut, ' ', app_nut, ' ', COALESCE(apm_nut, '')) as name, 
                especialidad_nut
         FROM nutriologos 
         WHERE id_nut = ? AND activo = 1 AND verificado = 'aprobado'`,
        [newNutritionistId]
      );
      
      if (nutriRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Nutriólogo no encontrado'
        });
      }
      
      const nutriologo = nutriRows[0];
      
      // Actualizar cliente
      await connection.execute(
        `UPDATE clientes 
         SET id_nut = ?, modo = 'supervisado' 
         WHERE id_cli = ?`,
        [newNutritionistId, clientId]
      );
      
      console.log(`✅ Cambio de nutriólogo confirmado para cliente ${clientId}`);
      
      res.json({
        success: true,
        message: `Cambio realizado. Ahora estás vinculado con ${nutriologo.name}`,
        nutritionist: {
          id: newNutritionistId,
          name: nutriologo.name,
          especialidad: nutriologo.especialidad_nut
        }
      });
      
    } finally {
      await connection.end();
    }
    
  } catch (error) {
    console.error('❌ Error confirmando cambio de nutriólogo:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

//Asignación automática de nutriólogo
app.post('/api/auto-assign-nutritionist', async (req, res) => {
  try {
    const { clientId } = req.body;
    
    console.log('🤖 === ASIGNACIÓN AUTOMÁTICA DE NUTRIÓLOGO ===');
    console.log('👤 Cliente ID:', clientId);
    
    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: 'ID de cliente es requerido'
      });
    }
    
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Verificar que el cliente existe
      const [clientRows] = await connection.execute(
        `SELECT id_cli, CONCAT(nombre_cli, ' ', app_cli) as client_name, id_nut 
         FROM clientes 
         WHERE id_cli = ?`,
        [clientId]
      );
      
      if (clientRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Cliente no encontrado'
        });
      }
      
      const cliente = clientRows[0];
      
      // Si ya tiene nutriólogo asignado, no hacer nada
      if (cliente.id_nut) {
        const [currentNutriRows] = await connection.execute(
          `SELECT CONCAT(nombre_nut, ' ', app_nut) as name 
           FROM nutriologos 
           WHERE id_nut = ?`,
          [cliente.id_nut]
        );
        
        const currentNutriName = currentNutriRows[0]?.name || 'Nutriólogo asignado';
        
        return res.json({
          success: true,
          message: `Ya tienes un nutriólogo asignado: ${currentNutriName}`,
          nutritionist: {
            id: cliente.id_nut,
            name: currentNutriName,
            assigned_type: 'existing'
          }
        });
      }
      
      // Buscar nutriólogo disponible con menos clientes
      const [availableNutriRows] = await connection.execute(`
        SELECT n.id_nut, 
               CONCAT(n.nombre_nut, ' ', n.app_nut, ' ', COALESCE(n.apm_nut, '')) as name,
               n.especialidad_nut,
               COUNT(c.id_cli) as client_count
        FROM nutriologos n
        LEFT JOIN clientes c ON n.id_nut = c.id_nut
        WHERE n.activo = 1 
          AND n.verificado = 'aprobado' 
          AND n.tiene_acceso = 1
        GROUP BY n.id_nut, n.nombre_nut, n.app_nut, n.apm_nut, n.especialidad_nut
        ORDER BY client_count ASC, RAND()
        LIMIT 1
      `);
      
      if (availableNutriRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No hay nutriólogos disponibles en este momento'
        });
      }
      
      const nutriologo = availableNutriRows[0];
      
      // Asignar nutriólogo al cliente
      await connection.execute(
        `UPDATE clientes 
         SET id_nut = ?, modo = 'supervisado' 
         WHERE id_cli = ?`,
        [nutriologo.id_nut, clientId]
      );
      
      console.log(`✅ Cliente ${cliente.client_name} asignado automáticamente a ${nutriologo.name}`);
      console.log(`📊 El nutriólogo tenía ${nutriologo.client_count} clientes`);
      
      res.json({
        success: true,
        message: `Se te ha asignado automáticamente el nutriólogo ${nutriologo.name}`,
        nutritionist: {
          id: nutriologo.id_nut,
          name: nutriologo.name,
          especialidad: nutriologo.especialidad_nut,
          assigned_type: 'automatic',
          previous_client_count: nutriologo.client_count
        },
        client_mode: 'supervisado'
      });
      
    } finally {
      await connection.end();
    }
    
  } catch (error) {
    console.error('❌ Error en asignación automática:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

//ThinkSpeak - Mongodb

const THINGSPEAK_CONFIG = {
  CHANNEL_ID: '3033451', 
  READ_API_KEY: 'ZUHPMQJMX3YE5BP7', 
  BASE_URL: 'https://api.thingspeak.com/channels'
};

async function syncThingSpeakToMongoDB() {
  try {
    console.log('🔄 === INICIANDO SINCRONIZACIÓN THINGSPEAK -> MONGODB ===');
    
    if (!mongoDB) {
      throw new Error('MongoDB no está conectado');
    }

    // 1. Obtener datos de ThingSpeak
    const thingSpeakData = await fetchThingSpeakData();
    
    if (!thingSpeakData || thingSpeakData.length === 0) {
      console.log('📊 No hay datos nuevos en ThingSpeak');
      return { success: true, message: 'No hay datos nuevos', processed: 0 };
    }

    console.log(`📥 Obtenidos ${thingSpeakData.length} registros de ThingSpeak`);

    // 2. Procesar y guardar cada registro en MongoDB
    const collection = mongoDB.collection('actividad_pasos');
    let processedCount = 0;
    let errorsCount = 0;

    for (const entry of thingSpeakData) {
      try {
        await processThingSpeakEntry(entry, collection);
        processedCount++;
      } catch (error) {
        console.error(`❌ Error procesando entrada:`, error);
        errorsCount++;
      }
    }

    console.log(`✅ Sincronización completada: ${processedCount} procesados, ${errorsCount} errores`);
    
    return {
      success: true,
      message: 'Sincronización completada',
      processed: processedCount,
      errors: errorsCount,
      total: thingSpeakData.length
    };

  } catch (error) {
    console.error('❌ Error en sincronización ThingSpeak:', error);
    throw error;
  }
}

async function fetchThingSpeakData(results = 100) {
  try {
    const url = `${THINGSPEAK_CONFIG.BASE_URL}/${THINGSPEAK_CONFIG.CHANNEL_ID}/feeds.json`;
    
    const params = {
      api_key: THINGSPEAK_CONFIG.READ_API_KEY,
      results: results, // Número de registros a obtener
      timezone: 'America/Mexico_City' // Ajusta según tu zona horaria
    };

    console.log('📡 Consultando ThingSpeak:', url);
    
    const response = await axios.get(url, { params });
    
    if (response.status !== 200) {
      throw new Error(`Error HTTP: ${response.status}`);
    }

    const data = response.data;
    
    if (!data.feeds || !Array.isArray(data.feeds)) {
      console.log('⚠️ No se encontraron feeds en ThingSpeak');
      return [];
    }

    console.log(`📊 Canal: ${data.channel.name}, Feeds: ${data.feeds.length}`);
    
    return data.feeds;

  } catch (error) {
    console.error('❌ Error obteniendo datos de ThingSpeak:', error);
    
    if (error.response) {
      console.error('📡 Respuesta de error:', error.response.status, error.response.data);
    }
    
    throw error;
  }
}

async function determineUserFromEntry(entry) {
  try {
    console.log('🔍 Determinando usuario para entrada de ThingSpeak:', entry.entry_id);
    
    // PRIORIDAD 1: Verificar si hay una asignación activa en memoria
    const assignment = connectedPedometers.get('thingspeak_device');
    if (assignment && assignment.connection_type === 'thingspeak') {
      console.log(`👤 Usuario asignado desde memoria: ${assignment.user_id} (${assignment.user_name})`);
      return assignment.user_id;
    }
    
    // PRIORIDAD 2: Buscar en base de datos el usuario más reciente
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Opción A: Usuario que más recientemente registró pasos
      const [recentStepsUser] = await connection.execute(
        `SELECT id_cli 
         FROM actividad_fisica 
         WHERE tipo_actividad = 'pasos' 
         ORDER BY last_update DESC 
         LIMIT 1`
      );
      
      if (recentStepsUser.length > 0) {
        const userId = recentStepsUser[0].id_cli;
        console.log(`👤 Usuario encontrado por actividad reciente: ${userId}`);
        return userId;
      }
      
      // Opción B: Usuario activo más reciente
      const [activeUser] = await connection.execute(
        `SELECT id_cli 
         FROM clientes 
         WHERE tiene_acceso = 1 
         ORDER BY id_cli DESC 
         LIMIT 1`
      );
      
      if (activeUser.length > 0) {
        const userId = activeUser[0].id_cli;
        console.log(`👤 Usuario activo encontrado: ${userId}`);
        return userId;
      }
      
      console.log('⚠️ No se encontró usuario, usando ID por defecto: 3');
      return 3; // Tu usuario actual como fallback
      
    } finally {
      await connection.end();
    }
    
  } catch (error) {
    console.error('❌ Error determinando usuario:', error);
    return 3; // Fallback a tu usuario actual
  }
}


app.post('/api/iot/pedometer/release-assignment', async (req, res) => {
  try {
    const { user_id } = req.body;
    
    const assignment = connectedPedometers.get('thingspeak_device');
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'No hay podómetro asignado'
      });
    }
    
    // Verificar que el usuario que libera es el correcto
    if (user_id && assignment.user_id !== parseInt(user_id)) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para liberar este podómetro'
      });
    }
    
    console.log(`✅ Liberando podómetro de usuario: ${assignment.user_name}`);
    
    // Remover asignación
    connectedPedometers.delete('thingspeak_device');
    
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

function cleanExpiredAssignments() {
  const now = new Date();
  const ASSIGNMENT_TIMEOUT = 24 * 60 * 60 * 1000; // 24 horas para ThingSpeak
  
  for (const [deviceId, assignment] of connectedPedometers.entries()) {
    if (assignment.connection_type === 'thingspeak') {
      const assignedTime = new Date(assignment.assigned_at);
      if (now - assignedTime > ASSIGNMENT_TIMEOUT) {
        console.log(`⏰ Liberando podómetro ThingSpeak ${deviceId} por timeout`);
        connectedPedometers.delete(deviceId);
      }
    }
  }
}

// Ejecutar limpieza cada hora
setInterval(cleanExpiredAssignments, 60 * 60 * 1000);


async function processThingSpeakEntry(entry, collection) {
  try {
    // Extraer datos de la entrada de ThingSpeak
    const pasos = parseInt(entry.field1) || 0; // field1 contiene los pasos
    const userId = parseInt(entry.field2) || null; // field2 contiene el user_id
    const created_at = new Date(entry.created_at);
    const entry_id = parseInt(entry.entry_id);
    
    // Si no hay user_id en field2, usar determinación automática
    const id_cli = userId || await determineUserFromEntry(entry);
    
    console.log(`📊 Procesando: ${pasos} pasos del usuario ${id_cli} (${created_at.toISOString()})`);

    // Resto de tu lógica existente...
    const fecha = created_at.toISOString().split('T')[0];
    const hora = created_at.toTimeString().split(' ')[0].slice(0, 5);
    const calorias_gastadas = Math.round(pasos * 0.04);
    const distancia_km = +(pasos * 0.75 / 1000).toFixed(2);

    // Verificar si ya existe este registro
    const existingDoc = await collection.findOne({
      entry_id_thingspeak: entry_id
    });

    if (existingDoc) {
      console.log(`⚠️ Registro ya existe (entry_id: ${entry_id}), omitiendo...`);
      return;
    }

    // Buscar registro existente para este usuario y fecha
    const existingDateDoc = await collection.findOne({
      id_cli: id_cli,
      fecha: fecha
    });

    const documento = {
      id_cli: id_cli,
      fecha: fecha,
      pasos: pasos,
      calorias_gastadas: calorias_gastadas,
      distancia_km: distancia_km,
      hora_ultima_actualizacion: hora,
      dispositivo: 'ESP32_ThingSpeak_Enhanced',
      estado: 'activo',
      timestamp: created_at,
      entry_id_thingspeak: entry_id,
      created_at_thingspeak: entry.created_at,
      sincronizado_desde: 'thingspeak_with_user',
      sincronizado_en: new Date(),
      user_id_from_device: userId // Indicar si vino del dispositivo
    };

    if (existingDateDoc) {
      // Solo actualizar si los pasos son mayores (evitar retrocesos)
      if (pasos >= existingDateDoc.pasos) {
        await collection.updateOne(
          { _id: existingDateDoc._id },
          { $set: documento }
        );
        console.log(`🔄 Actualizado registro existente: ${pasos} pasos`);
      } else {
         console.log(`⚠️ Pasos menores que existente (${pasos} < ${existingDateDoc.pasos}), no actualizando`);
     }
   } else {
     // Crear nuevo registro
     const result = await collection.insertOne(documento);
     console.log(`✅ Nuevo registro creado: ${result.insertedId}`);
   }

 } catch (error) {
   console.error('❌ Error procesando entrada de ThingSpeak:', error);
   throw error;
 }
}

app.post('/api/iot/pedometer/sync-user-steps', async (req, res) => {
  try {
    const { 
      user_id, 
      device_steps, 
      fecha, 
      device_id = 'thingspeak_esp32',
      force_sync = false 
    } = req.body;
    
    console.log('🔄 === SINCRONIZACIÓN DE PASOS POR USUARIO ===');
    console.log('📥 Datos recibidos:', { user_id, device_steps, fecha, force_sync });
    
    if (!user_id || device_steps === undefined || !fecha) {
      return res.status(400).json({
        success: false,
        message: 'user_id, device_steps y fecha son requeridos'
      });
    }

    // Verificar que el usuario está asignado
    const assignment = connectedPedometers.get('thingspeak_device');
    if (!assignment || assignment.user_id !== parseInt(user_id)) {
      return res.status(403).json({
        success: false,
        message: 'Usuario no asignado al podómetro'
      });
    }

    if (!mongoDB) {
      return res.status(500).json({
        success: false,
        message: 'MongoDB no disponible'
      });
    }

    const collection = mongoDB.collection('actividad_pasos');
    
    // Buscar registro existente para este usuario y fecha
    const existingDoc = await collection.findOne({
      id_cli: parseInt(user_id),
      fecha: fecha
    });

    const deviceStepsInt = parseInt(device_steps);
    let finalSteps = deviceStepsInt;
    let action = 'created';

    if (existingDoc) {
      const serverSteps = existingDoc.pasos || 0;
      
      if (force_sync) {
        // Forzar sincronización: usar los pasos del dispositivo
        finalSteps = deviceStepsInt;
        action = 'forced_sync';
      } else {
        // Sincronización inteligente: usar el mayor
        finalSteps = Math.max(serverSteps, deviceStepsInt);
        action = serverSteps > deviceStepsInt ? 'server_higher' : 
                 deviceStepsInt > serverSteps ? 'device_higher' : 'equal';
      }
    }

    // Calcular métricas
    const caloriasGastadas = Math.round(finalSteps * 0.04);
    const distanciaKm = +(finalSteps * 0.75 / 1000).toFixed(2);
    const horaActual = new Date().toTimeString().split(' ')[0].slice(0, 5);

    const documentoActualizado = {
      id_cli: parseInt(user_id),
      fecha: fecha,
      pasos: finalSteps,
      calorias_gastadas: caloriasGastadas,
      distancia_km: distanciaKm,
      hora_ultima_actualizacion: horaActual,
      dispositivo: 'ESP32_ThingSpeak_Sync',
      estado: 'activo',
      timestamp: new Date(),
      sincronizado_desde: 'device_sync',
      device_steps: deviceStepsInt,
      server_steps: existingDoc ? existingDoc.pasos : 0,
      sync_action: action
    };

    if (existingDoc) {
      await collection.updateOne(
        { _id: existingDoc._id },
        { $set: documentoActualizado }
      );
    } else {
      await collection.insertOne(documentoActualizado);
    }

    console.log(`✅ Sincronización completada: ${action}, pasos finales: ${finalSteps}`);

    res.json({
      success: true,
      message: 'Sincronización completada',
      sync_result: {
        user_id: parseInt(user_id),
        fecha: fecha,
        device_steps: deviceStepsInt,
        server_steps: existingDoc ? existingDoc.pasos : 0,
        final_steps: finalSteps,
        action: action,
        calories: caloriasGastadas,
        distance_km: distanciaKm
      }
    });

  } catch (error) {
    console.error('❌ Error en sincronización de pasos:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

//reset pasoss nuevo usuario
app.post('/api/iot/pedometer/reset-user-steps', async (req, res) => {
  try {
    const { user_id, fecha, reason = 'manual_reset' } = req.body;
    
    console.log('🔄 === RESET DE PASOS POR USUARIO ===');
    console.log('📥 Datos:', { user_id, fecha, reason });
    
    if (!user_id || !fecha) {
      return res.status(400).json({
        success: false,
        message: 'user_id y fecha son requeridos'
      });
    }

    if (!mongoDB) {
      return res.status(500).json({
        success: false,
        message: 'MongoDB no disponible'
      });
    }

    const collection = mongoDB.collection('actividad_pasos');
    
    const documentoReset = {
      id_cli: parseInt(user_id),
      fecha: fecha,
      pasos: 0,
      calorias_gastadas: 0,
      distancia_km: 0,
      hora_ultima_actualizacion: new Date().toTimeString().split(' ')[0].slice(0, 5),
      dispositivo: 'ESP32_Reset',
      estado: 'reset',
      timestamp: new Date(),
      reset_reason: reason
    };

    await collection.updateOne(
      { 
        id_cli: parseInt(user_id),
        fecha: fecha 
      },
      { $set: documentoReset },
      { upsert: true }
    );

    console.log(`✅ Pasos reseteados para usuario ${user_id} en fecha ${fecha}`);

    res.json({
      success: true,
      message: 'Pasos reseteados exitosamente',
      reset_data: {
        user_id: parseInt(user_id),
        fecha: fecha,
        reason: reason
      }
    });

  } catch (error) {
    console.error('❌ Error reseteando pasos:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

app.post('/api/sync/thingspeak', async (req, res) => {
  try {
    console.log('🔄 === SINCRONIZACIÓN MANUAL ACTIVADA ===');
    
    const { results = 50, user_id } = req.body;

    // Validar que MongoDB esté conectado
    if (!mongoDB) {
      return res.status(500).json({
        success: false,
        message: 'MongoDB no está conectado'
      });
    }

    // Ejecutar sincronización
    const syncResult = await syncThingSpeakToMongoDB();

    res.json({
      success: true,
      message: 'Sincronización ejecutada exitosamente',
      ...syncResult,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error en sincronización manual:', error);
    res.status(500).json({
      success: false,
      message: 'Error ejecutando sincronización',
      error: error.message
    });
  }
});

app.get('/api/thingspeak/latest/:results?', async (req, res) => {
  try {
    const results = parseInt(req.params.results) || 10;
    
    console.log(`📡 Obteniendo últimos ${results} registros de ThingSpeak`);
    
    const data = await fetchThingSpeakData(results);
    
    res.json({
      success: true,
      total_records: data.length,
      data: data.map(entry => ({
        entry_id: entry.entry_id,
        pasos: entry.field1,
        created_at: entry.created_at,
        fecha: new Date(entry.created_at).toISOString().split('T')[0],
        hora: new Date(entry.created_at).toTimeString().split(' ')[0]
      }))
    });

  } catch (error) {
    console.error('❌ Error obteniendo datos de ThingSpeak:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo datos de ThingSpeak',
      error: error.message
    });
  }
});
function startAutoSync() {
  console.log('⏰ Iniciando sincronización automática cada 5 minutos');
  
  // Ejecutar inmediatamente una vez
  setTimeout(async () => {
    try {
      console.log('🔄 Primera sincronización automática...');
      await syncThingSpeakToMongoDB();
    } catch (error) {
      console.error('❌ Error en primera sincronización:', error);
    }
  }, 10000); // Esperar 10 segundos después del inicio

  // Configurar intervalo de 5 minutos
  setInterval(async () => {
    try {
      console.log('⏰ Ejecutando sincronización automática...');
      await syncThingSpeakToMongoDB();
    } catch (error) {
      console.error('❌ Error en sincronización automática:', error);
    }
  }, 5 * 60 * 1000); // 5 minutos
}

// =============================================================================
// ENDPOINT PARA VERIFICAR CONFIGURACIÓN DE THINGSPEAK
// =============================================================================

app.get('/api/thingspeak/config', (req, res) => {
  res.json({
    success: true,
    config: {
      channel_id: THINGSPEAK_CONFIG.CHANNEL_ID,
      has_read_key: !!THINGSPEAK_CONFIG.READ_API_KEY,
      base_url: THINGSPEAK_CONFIG.BASE_URL,
      mongodb_connected: !!mongoDB,
      mongodb_database: mongoDB ? mongoDB.databaseName : null
    }
  });
});

// =============================================================================
// ENDPOINT PARA ESTADÍSTICAS DE SINCRONIZACIÓN
// =============================================================================

app.get('/api/sync/stats', async (req, res) => {
  try {
    if (!mongoDB) {
      return res.status(500).json({
        success: false,
        message: 'MongoDB no conectado'
      });
    }

    const collection = mongoDB.collection('actividad_pasos');

    // Contar documentos sincronizados desde ThingSpeak
    const thingspeakDocs = await collection.countDocuments({
      sincronizado_desde: 'thingspeak'
    });

    // Obtener último registro sincronizado
    const lastSync = await collection.findOne(
      { sincronizado_desde: 'thingspeak' },
      { sort: { sincronizado_en: -1 } }
    );

    // Contar total de documentos
    const totalDocs = await collection.countDocuments();

    res.json({
      success: true,
      stats: {
        total_documents: totalDocs,
        thingspeak_documents: thingspeakDocs,
        last_sync: lastSync ? {
          fecha: lastSync.fecha,
          pasos: lastSync.pasos,
          sincronizado_en: lastSync.sincronizado_en,
          entry_id: lastSync.entry_id_thingspeak
        } : null,
        sync_percentage: totalDocs > 0 ? ((thingspeakDocs / totalDocs) * 100).toFixed(1) : '0.0'
      }
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

// INICIAR SINCRONIZACIÓN AUTOMÁTICA AL ARRANCAR EL SERVIDOR
// Agregar esto después de que MongoDB se conecte
setTimeout(() => {
  if (mongoDB) {
    console.log('🚀 MongoDB conectado, iniciando auto-sincronización con ThingSpeak');
    startAutoSync();
  } else {
    console.log('⚠️ MongoDB no conectado, sincronización automática deshabilitada');
  }
}, 15000); // Esperar 15 segundos para asegurar que MongoDB esté conectado

// Exportar funciones para uso en otros módulos
module.exports = {
  syncThingSpeakToMongoDB,
  fetchThingSpeakData,
  startAutoSync
};

// POST para obtener la dieta actual del cliente
app.post('/api/dieta-actual', async (req, res) => {
  const { idCliente } = req.body;

  if (!idCliente || isNaN(idCliente)) {
    return res.status(400).json({ error: 'ID de cliente inválido' });
  }

  try {
    // Query para obtener la dieta más reciente del cliente
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

    // Procesar resultados
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

    // Agrupar tiempos y alimentos
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

    // Ordenar por nombre de tiempo
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

// GET /payment/failure - Pago fallido
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

// GET /payment/pending - Pago pendiente
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

// POST /api/mercadopago/webhook - Webhook para notificaciones de MP
app.post('/api/mercadopago/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    
    console.log('🔔 Webhook MP recibido:', { type, data });

    if (type === 'payment') {
      const paymentId = data.id;
      
      // Obtener información del pago
      const paymentInfo = await payment.get({ id: paymentId });
      
      console.log('💰 Información del pago:', {
        id: paymentInfo.id,
        status: paymentInfo.status,
        status_detail: paymentInfo.status_detail,
        external_reference: paymentInfo.external_reference
      });

      // Procesar según el estado del pago
      if (paymentInfo.status === 'approved') {
        await procesarPagoAprobado(paymentInfo);
      } else if (paymentInfo.status === 'rejected') {
        await procesarPagoRechazado(paymentInfo);
      }
    }

    res.status(200).json({ success: true });

  } catch (error) {
    console.error('❌ Error en webhook MP:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/mercadopago/payment/:payment_id - Verificar estado de pago
app.get('/api/mercadopago/payment/:payment_id', async (req, res) => {
  try {
    const { payment_id } = req.params;
    
    const paymentInfo = await payment.get({ id: payment_id });
    
    res.json({
      success: true,
      payment: {
        id: paymentInfo.id,
        status: paymentInfo.status,
        status_detail: paymentInfo.status_detail,
        amount: paymentInfo.transaction_amount,
        currency: paymentInfo.currency_id,
        external_reference: paymentInfo.external_reference,
        date_created: paymentInfo.date_created,
        date_approved: paymentInfo.date_approved
      }
    });

  } catch (error) {
    console.error('❌ Error obteniendo pago MP:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo información del pago',
      error: error.message
    });
  }
});

// =============================================================================
// FUNCIONES AUXILIARES PARA MERCADO PAGO
// =============================================================================

// Procesar pago aprobado
const procesarPagoAprobado = async (paymentInfo) => {
  try {
    console.log('✅ Procesando pago aprobado:', paymentInfo.id);
    
    // Parsear external_reference
    let referenceData = {};
    try {
      referenceData = JSON.parse(paymentInfo.external_reference || '{}');
    } catch (e) {
      console.log('⚠️ No se pudo parsear external_reference');
    }

    const { user_id, plan_type } = referenceData;

    if (user_id) {
      // Actualizar acceso del usuario en la base de datos
      const connection = await mysql.createConnection(dbConfig);
      
      try {
        // Determinar el tipo de usuario y tabla
        let updateQuery = '';
        let tableName = '';
        
        if (plan_type === 'nutriologo') {
          tableName = 'nutriologos';
          updateQuery = `
            UPDATE nutriologos 
            SET tiene_acceso = TRUE, activo = TRUE, fecha_pago = NOW() 
            WHERE id_nut = ?
          `;
        } else {
          tableName = 'clientes';
          updateQuery = `
            UPDATE clientes 
            SET tiene_acceso = TRUE, fecha_pago = NOW() 
            WHERE id_cli = ?
          `;
        }

        await connection.execute(updateQuery, [user_id]);
        
        // Registrar el pago en tabla de pagos
        await connection.execute(
          `INSERT INTO pagos_registrados 
           (user_id, plan_type, monto, moneda, payment_id, estado, fecha_pago) 
           VALUES (?, ?, ?, ?, ?, 'approved', NOW())`,
          [
            user_id,
            plan_type || 'cliente',
            paymentInfo.transaction_amount,
            paymentInfo.currency_id,
            paymentInfo.id
          ]
        );

        console.log(`✅ Acceso activado para ${plan_type || 'cliente'} ID: ${user_id}`);
        
      } finally {
        await connection.end();
      }
    }

  } catch (error) {
    console.error('❌ Error procesando pago aprobado:', error);
  }
};

// Procesar pago rechazado
const procesarPagoRechazado = async (paymentInfo) => {
  try {
    console.log('❌ Procesando pago rechazado:', paymentInfo.id);
    
    let referenceData = {};
    try {
      referenceData = JSON.parse(paymentInfo.external_reference || '{}');
    } catch (e) {
      console.log('⚠️ No se pudo parsear external_reference');
    }

    const { user_id, plan_type } = referenceData;

    if (user_id) {
      const connection = await mysql.createConnection(dbConfig);
      
      try {
        // Registrar el pago fallido
        await connection.execute(
          `INSERT INTO pagos_registrados 
           (user_id, plan_type, monto, moneda, payment_id, estado, fecha_pago) 
           VALUES (?, ?, ?, ?, ?, 'rejected', NOW())`,
          [
            user_id,
            plan_type || 'cliente',
            paymentInfo.transaction_amount,
            paymentInfo.currency_id,
            paymentInfo.id
          ]
        );

        console.log(`❌ Pago rechazado para ${plan_type || 'cliente'} ID: ${user_id}`);
        
      } finally {
        await connection.end();
      }
    }

  } catch (error) {
    console.error('❌ Error procesando pago rechazado:', error);
  }
};

// GET /api/mercadopago/plans - Obtener planes disponibles
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

// Configuración MongoDB Atlas desde .env
const mongoUrl = process.env.MONGO_URI;
const mongoDbName = process.env.MONGO_DB;

// Pool de conexiones MySQL
const pool = mysql.createPool(dbConfig);

// Cliente MongoDB
let mongoClient;
let mongoDB = null;

//conectar mongodb
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

    // Verificar actividad_pasos específicamente
    const actividadExists = colecciones.find(c => c.name === 'actividad_pasos');
    if (actividadExists) {
      console.log("✅ Colección actividad_pasos encontrada");
      const actividadCollection = mongoDB.collection('actividad_pasos');
      const count = await actividadCollection.countDocuments();
      console.log("📊 Total documentos en actividad_pasos:", count);
      
      if (count > 0) {
        const samples = await actividadCollection.find({}).limit(3).toArray();
        console.log("📋 Documentos de muestra:");
        samples.forEach((doc, index) => {
          console.log(`  ${index + 1}. id_cli: ${doc.id_cli}, fecha: ${doc.fecha}, pasos: ${doc.pasos}`);
        });
      }
    } else {
      console.log("❌ Colección actividad_pasos NO encontrada");
    }

  } catch (err) {
    console.error('❌ Error conectando a MongoDB:', err);
  }
}
connectMongo();

// DEBUGGING TEMPORAL - Agregar después de connectMongo()
setTimeout(async () => {
  try {
    console.log("🔍 === DEBUGGING COMPLETO ===");
    console.log("MONGO_URI:", process.env.MONGO_URI);
    console.log("MONGO_DB:", process.env.MONGO_DB);
    
    if (mongoDB) {
      console.log("Database name:", mongoDB.databaseName);
      
      // Listar TODAS las colecciones
      const admin = mongoDB.admin();
      const result = await admin.listCollections().toArray();
      console.log("Colecciones ADMIN:", result.map(c => c.name));
      
      // Método alternativo
      const collections = await mongoDB.collections();
      console.log("Colecciones método 2:", collections.map(c => c.collectionName));
      
      // Verificar actividad_pasos directamente
      try {
        const actividadCollection = mongoDB.collection('actividad_pasos');
        const stats = await actividadCollection.stats();
        console.log("Stats actividad_pasos:", stats);
      } catch (statsError) {
        console.log("Error obteniendo stats:", statsError.message);
      }
      
    } else {
      console.log("❌ mongoDB es null!");
    }
  } catch (debugError) {
    console.error("❌ Error en debugging:", debugError);
  }
}, 5000); // Esperar 5 segundos después de conectar
//iot
// Estado de la báscula
let scaleState = {
  connected: false,
  weight: 0,
  lastUpdate: null,
  calibrated: true,
  currentFood: null, // Información del alimento actual
  targetWeight: 0,   // Peso objetivo
  isWeighing: false  // Si está en proceso de pesado
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
        const deviceKey = data.device_id || 'default';
        scaleState.connected = true;
        scaleState.lastUpdate = new Date();
        console.log('⚖️ Báscula conectada:', deviceKey);
        
        ws.send(JSON.stringify({
          type: 'connection_confirmed',
          device: 'scale',
          device_id: deviceKey,
          timestamp: new Date().toISOString()
        }));
      }

      if (data.type === 'weight_update') {
        scaleState.weight = parseFloat(data.weight) || 0;
        scaleState.lastUpdate = new Date();
        console.log('⚖️ Peso actualizado:', scaleState.weight, 'g');
        
        // Si está pesando y hay un objetivo, verificar si está cerca
        if (scaleState.isWeighing && scaleState.targetWeight > 0) {
          const difference = Math.abs(scaleState.weight - scaleState.targetWeight);
          const tolerance = scaleState.targetWeight * 0.1; // 10% de tolerancia
          
          if (difference <= tolerance && scaleState.weight > 10) {
            // Peso alcanzado, notificar
            broadcastToClients({
              type: 'target_weight_reached',
              current_weight: scaleState.weight,
              target_weight: scaleState.targetWeight,
              difference: difference
            });
          }
        }
      }

       if (data.type === 'weighing_complete') {
        scaleState.weight = parseFloat(data.weight) || 0;
        scaleState.isWeighing = false;
        scaleState.lastUpdate = new Date();
        console.log('✅ Pesado completado:', scaleState.weight, 'g');
        
        broadcastToClients({
          type: 'weighing_completed',
          final_weight: scaleState.weight,
          food_info: scaleState.currentFood
        });
      }

      if (data.type === 'scale_calibrated') {
        scaleState.calibrated = true;
        console.log('✅ Báscula calibrada');
        
        broadcastToClients({
          type: 'scale_calibrated',
          timestamp: new Date().toISOString()
        });
      }

      const broadcastToClients = (message) => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
};
      
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
    success: true,
    connected: scaleState.connected,
    weight: scaleState.weight,
    lastUpdate: scaleState.lastUpdate,
    calibrated: scaleState.calibrated,
    isWeighing: scaleState.isWeighing,
    currentFood: scaleState.currentFood,
    targetWeight: scaleState.targetWeight
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

app.post('/api/iot/scale/status', (req, res) => {
  try {
    const { 
      device_id, 
      weight, 
      connected, 
      calibrated, 
      is_weighing, 
      target_weight, 
      food_name,
      weight_difference,
      target_reached,
      timestamp 
    } = req.body;

    console.log('⚖️ Estado actualizado desde ESP32:', {
      device_id,
      weight,
      connected,
      is_weighing
    });

    // Actualizar estado global de la báscula
    scaleState.connected = connected || false;
    scaleState.weight = parseFloat(weight) || 0;
    scaleState.calibrated = calibrated || false;
    scaleState.isWeighing = is_weighing || false;
    scaleState.lastUpdate = new Date();

    if (is_weighing) {
      scaleState.targetWeight = parseFloat(target_weight) || 0;
      scaleState.currentFood = {
        name: food_name || 'Alimento',
        target_weight: target_weight
      };
    }

    // Verificar si hay comandos pendientes para la báscula
    let comandoPendiente = null;
    
    // Aquí puedes agregar lógica para comandos pendientes
    // Por ejemplo, verificar en base de datos si hay comandos para enviar

    res.json({
      success: true,
      message: 'Estado actualizado',
      timestamp: new Date().toISOString(),
      current_state: {
        connected: scaleState.connected,
        weight: scaleState.weight,
        is_weighing: scaleState.isWeighing,
        calibrated: scaleState.calibrated
      },
      command: comandoPendiente // null si no hay comandos
    });

  } catch (error) {
    console.error('❌ Error procesando estado báscula:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

// GET /api/iot/scale/status - Obtener estado actual (desde app)
app.get('/api/iot/scale/status', (req, res) => {
  try {
    console.log('📱 Consultando estado báscula desde app');

    res.json({
      success: true,
      connected: scaleState.connected,
      weight: scaleState.weight,
      lastUpdate: scaleState.lastUpdate,
      calibrated: scaleState.calibrated,
      isWeighing: scaleState.isWeighing,
      currentFood: scaleState.currentFood,
      targetWeight: scaleState.targetWeight
    });

  } catch (error) {
    console.error('❌ Error obteniendo estado báscula:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo estado',
      error: error.message
    });
  }
});

app.get('/api/iot/scale/status', (req, res) => {
  try {
    console.log('📱 Consultando estado báscula desde app');

    res.json({
      success: true,
      connected: scaleState.connected,
      weight: scaleState.weight,
      lastUpdate: scaleState.lastUpdate,
      calibrated: scaleState.calibrated,
      isWeighing: scaleState.isWeighing,
      currentFood: scaleState.currentFood,
      targetWeight: scaleState.targetWeight
    });

  } catch (error) {
    console.error('❌ Error obteniendo estado báscula:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo estado',
      error: error.message
    });
  }
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

// En tu endpoint /api/iot/pedometer/steps/mongo/:id_cli
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
    console.log('🧪 Consulta esperada con fecha:', fecha);

    const collection = mongoDB.collection('actividad_pasos');

    // 🔍 DEBUGGING COMPLETO
    try {
      // Verificar que la colección existe
      const collections = await mongoDB.listCollections().toArray();
      console.log('📚 Todas las colecciones:', collections.map(c => c.name));

      // Contar documentos totales
      const totalDocs = await collection.countDocuments();
      console.log('📊 Total documentos en actividad_pasos:', totalDocs);

      // Ver TODOS los documentos
      const allDocs = await collection.find({}).toArray();
      console.log('📄 TODOS los documentos:', JSON.stringify(allDocs, null, 2));

      // Ver documentos para este usuario específico
      const userDocs = await collection.find({ id_cli: parseInt(id_cli) }).toArray();
      console.log('👤 Documentos para usuario', id_cli, ':', JSON.stringify(userDocs, null, 2));

      // Ver documentos para esta fecha específica
      if (fecha) {
        const dateDocs = await collection.find({ fecha: fecha }).toArray();
        console.log('📅 Documentos para fecha', fecha, ':', JSON.stringify(dateDocs, null, 2));
      }

    } catch (debugError) {
      console.error('❌ Error en debugging:', debugError);
    }

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

    console.log("📄 Documentos encontrados con filtro:", documentos);

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

// REEMPLAZA COMPLETAMENTE tu endpoint POST /api/iot/pedometer/save

app.post('/api/iot/pedometer/save', async (req, res) => {
  try {
    const { id_cli, steps, fecha } = req.body;
    
    console.log('💾 === GUARDANDO PASOS EN BD ===');
    console.log('📥 Datos recibidos:', { id_cli, steps, fecha });
    console.log('📥 Tipo de datos:', typeof id_cli, typeof steps, typeof fecha);
    
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

    console.log('📊 Datos calculados:', {
      id_cli: parseInt(id_cli),
      pasos: parseInt(steps),
      calorias_gastadas: caloriasGastadas,
      distancia_km: distanciaKm,
      fecha: today,
      hora: horaActual
    });

    // === VERIFICAR CONEXIÓN MONGODB ===
    if (!mongoDB) {
      console.log('❌ MongoDB no está conectado');
      return res.status(500).json({ 
        success: false, 
        message: 'Base de datos MongoDB no disponible' 
      });
    }

    console.log('✅ MongoDB conectado, base de datos:', mongoDB.databaseName);

    // === GUARDAR EN MONGODB PRIMERO ===
    let mongoResult = null;
    try {
      const collection = mongoDB.collection('actividad_pasos');
      console.log('📂 Usando colección: actividad_pasos');

      // Verificar si ya existe registro para hoy
      const filter = {
        id_cli: parseInt(id_cli),
        fecha: today
      };
      
      console.log('🔍 Buscando documento existente con filtro:', filter);
      const existingDoc = await collection.findOne(filter);
      console.log('🔍 Documento existente encontrado:', existingDoc ? 'SÍ' : 'NO');
      if (existingDoc) {
        console.log('📄 Documento existente:', JSON.stringify(existingDoc, null, 2));
      }

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

      console.log('📄 Documento a guardar/actualizar:', JSON.stringify(documentoMongo, null, 2));

      if (existingDoc) {
        // Actualizar documento existente
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
        
        console.log('🔄 Resultado actualización:', {
          acknowledged: updateResult.acknowledged,
          matchedCount: updateResult.matchedCount,
          modifiedCount: updateResult.modifiedCount
        });
        
        mongoResult = { updated: true, id: existingDoc._id };
      } else {
        // Crear nuevo documento
        const insertResult = await collection.insertOne(documentoMongo);
        
        console.log('➕ Resultado inserción:', {
          acknowledged: insertResult.acknowledged,
          insertedId: insertResult.insertedId
        });
        
        mongoResult = { inserted: true, id: insertResult.insertedId };
      }

      // VERIFICACIÓN POST-GUARDADO
      console.log('🔍 === VERIFICACIÓN POST-GUARDADO ===');
      const verifyDoc = await collection.findOne(filter);
      
      if (verifyDoc) {
        console.log('✅ VERIFICACIÓN EXITOSA - Documento encontrado:');
        console.log('📋 ID:', verifyDoc._id);
        console.log('📋 Pasos:', verifyDoc.pasos);
        console.log('📋 Fecha:', verifyDoc.fecha);
        console.log('📋 Hora:', verifyDoc.hora_ultima_actualizacion);
        console.log('📋 Timestamp:', verifyDoc.timestamp);
      } else {
        console.log('❌ VERIFICACIÓN FALLIDA - Documento NO encontrado después del guardado');
        throw new Error('El documento no se pudo verificar después del guardado');
      }

      // VERIFICAR TOTAL DE DOCUMENTOS EN LA COLECCIÓN
      const totalDocs = await collection.countDocuments();
      console.log('📊 Total documentos en actividad_pasos:', totalDocs);
      
      // MOSTRAR ÚLTIMOS 3 DOCUMENTOS
      const recentDocs = await collection.find({}).sort({timestamp: -1}).limit(3).toArray();
      console.log('📄 Últimos 3 documentos:');
      recentDocs.forEach((doc, index) => {
        console.log(`  ${index + 1}. ID: ${doc._id}, Usuario: ${doc.id_cli}, Pasos: ${doc.pasos}, Fecha: ${doc.fecha}`);
      });

    } catch (mongoError) {
      console.error('❌ Error específico de MongoDB:', mongoError);
      console.error('❌ Stack trace:', mongoError.stack);
      
      // Continuar con MySQL aunque falle MongoDB
      console.log('⚠️ Continuando con MySQL...');
    }

    // === GUARDAR EN MYSQL (BACKUP) ===
    try {
      const connection = await mysql.createConnection(dbConfig);
      
      try {
        // Verificar si existe en MySQL
        const [existingRows] = await connection.execute(
          `SELECT id_actividad FROM actividad_fisica 
           WHERE id_cli = ? AND fecha = ? AND tipo_actividad = 'pasos'`,
          [id_cli, today]
        );

        if (existingRows.length > 0) {
          // Actualizar en MySQL
          await connection.execute(
            `UPDATE actividad_fisica 
             SET pasos_totales = ?, calorias_quemadas = ?, hora_actualizacion = ?, last_update = NOW()
             WHERE id_cli = ? AND fecha = ? AND tipo_actividad = 'pasos'`,
            [steps, caloriasGastadas, horaActual, id_cli, today]
          );
          console.log('🔄 Actualizado en MySQL');
        } else {
          // Insertar en MySQL
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

    console.log('💾 === GUARDADO COMPLETADO ===');
    console.log('✅ MongoDB:', mongoResult ? 'EXITOSO' : 'FALLÓ');
    console.log('✅ MySQL: COMPLETADO');

    res.json({
      success: true,
      message: 'Pasos guardados exitosamente',
      steps: parseInt(steps),
      date: today,
      saved_to: mongoResult ? ['mongodb', 'mysql'] : ['mysql'],
      mongo_result: mongoResult,
      debug: {
        received_data: { id_cli, steps, fecha },
        processed_data: { id_cli: parseInt(id_cli), steps: parseInt(steps), fecha: today },
        mongo_connected: !!mongoDB,
        database_name: mongoDB ? mongoDB.databaseName : null
      }
    });

  } catch (error) {
    console.error('❌ Error general en save endpoint:', error);
    console.error('❌ Stack trace completo:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message,
      stack: error.stack
    });
  }
});

app.post('/api/iot/pedometer/assign-to-user', async (req, res) => {
  try {
    const { user_id, user_name, device_id } = req.body;
    
    console.log('📱 === ASIGNANDO PODÓMETRO THINGSPEAK A USUARIO ===');
    console.log('📥 Datos recibidos:', { user_id, user_name, device_id });
    
    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: 'user_id es requerido'
      });
    }
    
    // Verificar que el usuario existe
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [userRows] = await connection.execute(
        'SELECT id_cli, CONCAT(nombre_cli, " ", app_cli) as nombre FROM clientes WHERE id_cli = ?',
        [user_id]
      );
      
      if (userRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Usuario no encontrado en la base de datos'
        });
      }
      
      const user = userRows[0];
      
      // Verificar si ya hay otro usuario asignado
      const existingAssignment = connectedPedometers.get('thingspeak_device');
      if (existingAssignment && existingAssignment.user_id !== parseInt(user_id)) {
        return res.status(409).json({
          success: false,
          message: `El podómetro ya está asignado a ${existingAssignment.user_name}`,
          current_assignment: existingAssignment
        });
      }
      
      // Crear nueva asignación
      const assignment = {
        user_id: parseInt(user_id),
        user_name: user.nombre,
        device_id: device_id || 'thingspeak_esp32',
        assigned_at: new Date().toISOString(),
        status: 'active',
        connection_type: 'thingspeak',
        device_type: 'ESP32 + ThingSpeak'
      };
      
      // Guardar asignación
      connectedPedometers.set('thingspeak_device', assignment);
      
      console.log(`✅ Podómetro ThingSpeak asignado a usuario ${user_id} (${user.nombre})`);
      
      res.json({
        success: true,
        message: 'Podómetro ThingSpeak asignado exitosamente',
        assignment: {
          user_id: parseInt(user_id),
          user_name: user.nombre,
          device_id: assignment.device_id,
          device_type: assignment.device_type,
          assigned_at: assignment.assigned_at
        }
      });
      
    } finally {
      await connection.end();
    }
    
  } catch (error) {
    console.error('❌ Error asignando podómetro:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo estadísticas',
      error: error.message
    });
  }
});


app.get('/api/iot/pedometer/system-status', async (req, res) => {
  try {
    // Verificar estado de ThingSpeak
    let thingspeakStatus = 'unknown';
    let lastEntry = null;
    
    try {
      const data = await fetchThingSpeakData(1);
      if (data && data.length > 0) {
        thingspeakStatus = 'active';
        lastEntry = {
          entry_id: data[0].entry_id,
          steps: data[0].field1,
          created_at: data[0].created_at,
          age_minutes: Math.round((new Date() - new Date(data[0].created_at)) / (1000 * 60))
        };
      } else {
        thingspeakStatus = 'no_data';
      }
    } catch (error) {
      thingspeakStatus = 'error';
    }

    // Verificar estado de MongoDB
    let mongoStatus = 'disconnected';
    let mongoStats = null;
    
    if (mongoDB) {
      try {
        const collection = mongoDB.collection('actividad_pasos');
        const totalDocs = await collection.countDocuments();
        const thingspeakDocs = await collection.countDocuments({ 
          sincronizado_desde: 'thingspeak' 
        });
        
        mongoStatus = 'connected';
        mongoStats = {
          total_documents: totalDocs,
          thingspeak_documents: thingspeakDocs,
          sync_percentage: totalDocs > 0 ? ((thingspeakDocs / totalDocs) * 100).toFixed(1) : '0.0'
        };
      } catch (error) {
        mongoStatus = 'error';
      }
    }

    // Estado de asignaciones
    const assignment = connectedPedometers.get('thingspeak_device');
    
    res.json({
      success: true,
      system_status: {
        thingspeak: {
          status: thingspeakStatus,
          channel_id: THINGSPEAK_CONFIG.CHANNEL_ID,
          has_read_key: !!THINGSPEAK_CONFIG.READ_API_KEY,
          last_entry: lastEntry
        },
        mongodb: {
          status: mongoStatus,
          database: mongoDB ? mongoDB.databaseName : null,
          stats: mongoStats
        },
        assignments: {
          has_active_assignment: !!assignment,
          assignment_info: assignment || null,
          total_assignments: connectedPedometers.size
        },
        sync: {
          auto_sync_enabled: true,
          interval_minutes: 5,
          last_check: new Date().toISOString()
        }
      },
      recommendations: generateSystemRecommendations(thingspeakStatus, mongoStatus, assignment)
    });

  } catch (error) {
    console.error('❌ Error obteniendo estado del sistema:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo estado del sistema',
      error: error.message
    });
  }
});

function generateSystemRecommendations(thingspeakStatus, mongoStatus, assignment) {
  const recommendations = [];

  if (thingspeakStatus === 'error') {
    recommendations.push({
      type: 'error',
      message: 'ThingSpeak no responde. Verifica tu Read API Key y conexión.',
      action: 'check_thingspeak_config'
    });
  } else if (thingspeakStatus === 'no_data') {
    recommendations.push({
      type: 'warning',
      message: 'No hay datos recientes en ThingSpeak. Verifica que el ESP32 esté enviando datos.',
      action: 'check_esp32_connection'
    });
  }

  if (mongoStatus === 'disconnected') {
    recommendations.push({
      type: 'error',
      message: 'MongoDB desconectado. Los datos no se pueden almacenar.',
      action: 'check_mongodb_connection'
    });
  }

  if (!assignment) {
    recommendations.push({
      type: 'info',
      message: 'No hay usuario asignado al podómetro. Los datos se asignarán al usuario más reciente.',
      action: 'assign_user'
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      type: 'success',
      message: 'Sistema funcionando correctamente. Todos los componentes están operativos.',
      action: 'none'
    });
  }

  return recommendations;
}

app.post('/api/iot/pedometer/auto-assign', async (req, res) => {
  try {
    console.log('🤖 === ASIGNACIÓN AUTOMÁTICA DE USUARIO ===');
    
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Buscar usuario más activo recientemente
      const [userRows] = await connection.execute(
        `SELECT c.id_cli, CONCAT(c.nombre_cli, ' ', c.app_cli) as nombre
         FROM clientes c
         LEFT JOIN actividad_fisica af ON c.id_cli = af.id_cli AND af.tipo_actividad = 'pasos'
         WHERE c.tiene_acceso = 1
         ORDER BY af.last_update DESC, c.id_cli DESC
         LIMIT 1`
      );
      
      if (userRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No se encontraron usuarios activos'
        });
      }
      
      const user = userRows[0];
      
      // Crear asignación automática
      const assignment = {
        user_id: user.id_cli,
        user_name: user.nombre,
        device_id: 'thingspeak_esp32_auto',
        assigned_at: new Date().toISOString(),
        status: 'active',
        connection_type: 'thingspeak',
        device_type: 'ESP32 + ThingSpeak (Auto)',
        auto_assigned: true
      };
      
      connectedPedometers.set('thingspeak_device', assignment);
      
      console.log(`🤖 Auto-asignado a usuario ${user.id_cli} (${user.nombre})`);
      
      res.json({
        success: true,
        message: 'Usuario asignado automáticamente',
        assignment: assignment
      });
      
    } finally {
      await connection.end();
    }
    
  } catch (error) {
    console.error('❌ Error en asignación automática:', error);
    res.status(500).json({
      success: false,
      message: 'Error en asignación automática',
      error: error.message
    });
  }
});


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
    
    // Verificar que el usuario existe en la BD
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
      
      const user = userRows[0];
      const deviceKey = device_id || 'default';
      
      // Crear asignación
      const assignment = {
        user_id: parseInt(user_id),
        user_name: user_name,
        device_id: deviceKey,
        assigned_at: new Date().toISOString(),
        status: 'active'
      };
      
      // Guardar asignación
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

app.get('/api/iot/pedometer/assigned-user', (req, res) => {
  try {
    const assignment = connectedPedometers.get('thingspeak_device');
    
    if (assignment && assignment.connection_type === 'thingspeak') {
      res.json({
        success: true,
        assigned: true,
        user: {
          user_id: assignment.user_id,
          user_name: assignment.user_name,
          device_id: assignment.device_id,
          device_type: assignment.device_type,
          assigned_at: assignment.assigned_at
        }
      });
    } else {
      res.json({
        success: true,
        assigned: false,
        message: 'No hay usuario asignado al podómetro ThingSpeak'
      });
    }
    
  } catch (error) {
    console.error('❌ Error obteniendo usuario asignado:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo información de asignación'
    });
  }
});

app.post('/api/iot/pedometer/release-assignment', async (req, res) => {
  try {
    const { user_id } = req.body;
    
    const assignment = connectedPedometers.get('thingspeak_device');
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'No hay podómetro asignado'
      });
    }
    
    // Verificar permisos
    if (user_id && assignment.user_id !== parseInt(user_id)) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para liberar este podómetro'
      });
    }
    
    console.log(`✅ Liberando podómetro ThingSpeak de usuario: ${assignment.user_name}`);
    
    // Remover asignación
    connectedPedometers.delete('thingspeak_device');
    
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

app.get('/api/iot/pedometer/stats/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const { days = 7 } = req.query;

    if (!mongoDB) {
      return res.status(500).json({
        success: false,
        message: 'MongoDB no está disponible'
      });
    }

    const collection = mongoDB.collection('actividad_pasos');

    // Calcular rango de fechas
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - parseInt(days));

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    // Pipeline de agregación para estadísticas
    const pipeline = [
      {
        $match: {
          id_cli: parseInt(id_cli),
          fecha: {
            $gte: startDateStr,
            $lte: endDateStr
          }
        }
      },
      {
        $group: {
          _id: null,
          total_pasos: { $sum: "$pasos" },
          total_calorias: { $sum: "$calorias_gastadas" },
          total_distancia: { $sum: "$distancia_km" },
          dias_activos: { $sum: 1 },
          promedio_pasos: { $avg: "$pasos" },
          max_pasos: { $max: "$pasos" },
          min_pasos: { $min: "$pasos" }
        }
      }
    ];

    const [stats] = await collection.aggregate(pipeline).toArray();

    // Datos diarios para gráfico
    const dailyData = await collection
      .find({
        id_cli: parseInt(id_cli),
        fecha: { $gte: startDateStr, $lte: endDateStr }
      })
      .sort({ fecha: 1 })
      .toArray();

    // Verificar asignación
    const assignment = connectedPedometers.get('thingspeak_device');
    const isAssigned = assignment && assignment.user_id === parseInt(id_cli);

    res.json({
      success: true,
      user_id: parseInt(id_cli),
      period_days: parseInt(days),
      date_range: { start: startDateStr, end: endDateStr },
      is_assigned_to_pedometer: isAssigned,
      assignment_info: isAssigned ? assignment : null,
      summary: stats || {
        total_pasos: 0,
        total_calorias: 0,
        total_distancia: 0,
        dias_activos: 0,
        promedio_pasos: 0,
        max_pasos: 0,
        min_pasos: 0
      },
      daily_data: dailyData,
      thingspeak_info: {
        source: 'thingspeak',
        channel_id: THINGSPEAK_CONFIG.CHANNEL_ID,
        sync_enabled: true,
        last_check: new Date().toISOString()
      }
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



// POST /api/iot/pedometer/release - VERSIÓN CORREGIDA
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
    
    // Verificar que el usuario que libera es el mismo que está asignado
    if (user_id && assignment.user_id !== user_id) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para liberar este podómetro'
      });
    }
    
    console.log('✅ Liberando podómetro de usuario:', assignment.user_name);
    
    // Remover asignación
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

// GET /api/iot/pedometer/assignments - VERSIÓN CORREGIDA
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

// GET /api/iot/pedometer/available - VERSIÓN CORREGIDA
app.get('/api/iot/pedometer/available', (req, res) => {
  try {
    // Simular dispositivos disponibles
    const totalDevices = 3; // Simular 3 dispositivos
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

// POST /api/iot/pedometer/command - VERSIÓN CORREGIDA
app.post('/api/iot/pedometer/command', async (req, res) => {
  try {
    const { command, user_id, device_id, parameters } = req.body;
    
    console.log('📱 === COMANDO PODÓMETRO ===');
    console.log('📥 Comando recibido:', { command, user_id, device_id, parameters });
    
    if (!command) {
      return res.status(400).json({
        success: false,
        message: 'Comando es requerido'
      });
    }
    
    const deviceKey = device_id || 'default';
    const assignment = connectedPedometers.get(deviceKey);
    
    console.log('📱 Buscando asignación para device:', deviceKey);
    console.log('📱 Asignación encontrada:', assignment);

    // Para comandos básicos, no requieren asignación específica
    if (['status', 'help', 'wifi'].includes(command)) {
      console.log(`📱 Comando '${command}' no requiere asignación específica`);
    } else if (['start', 'stop', 'reset', 'send'].includes(command)) {
      // Verificar que hay una asignación activa para comandos que requieren usuario
      if (!assignment) {
        return res.status(400).json({
          success: false,
          message: 'No hay usuario asignado al podómetro para este comando'
        });
      }
      
      // Verificar que el usuario que envía el comando es el propietario
      if (user_id && assignment.user_id !== user_id) {
        return res.status(403).json({
          success: false,
          message: 'No tienes permisos para controlar este podómetro'
        });
      }
    }
    
    console.log(`📱 Enviando comando '${command}' al podómetro ${deviceKey}`);
    
    // Aquí simularemos que el comando se envía correctamente
    // En un escenario real, aquí enviarías via WebSocket al ESP32
    
    res.json({
      success: true,
      message: `Comando '${command}' enviado exitosamente`,
      command: command,
      device_id: deviceKey,
      target_user: assignment ? assignment.user_name : null,
      simulated: true // Indicar que es simulado
    });
    
  } catch (error) {
    console.error('❌ Error enviando comando:', error);
    res.status(500).json({
      success: false,
      message: 'Error enviando comando',
      error: error.message
    });
  }
});

app.get('/api/detalle/:id', async (req, res) => {
 try {
   const idNut = req.params.id;
   
   if (!idNut) {
     return res.status(400).json({ error: 'Falta id de nutriólogo' });
   }

   const connection = await mysql.createConnection(dbConfig);
   
   try {
     const [results] = await connection.execute(
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
   } finally {
     await connection.end();
   }
 } catch (error) {
   console.error('Error obteniendo detalle nutriólogo:', error);
   res.status(500).json({ error: 'Error en base de datos' });
 }
});

// AGREGAR este endpoint a tu server.js para debugging MongoDB:

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
    
    // 1. Contar documentos totales
    const totalDocs = await collection.countDocuments();
    console.log('📊 Total documentos:', totalDocs);
    
    // 2. Ver TODOS los documentos
    const allDocs = await collection.find({}).toArray();
    console.log('📄 Todos los documentos:', allDocs);
    
    // 3. Documentos para este usuario
    const userDocs = await collection.find({ id_cli: parseInt(id_cli) }).toArray();
    console.log('👤 Documentos del usuario', id_cli, ':', userDocs);
    
    // 4. Documentos de HOY
    const today = new Date().toISOString().split('T')[0];
    const todayDocs = await collection.find({ fecha: today }).toArray();
    console.log('📅 Documentos de hoy (' + today + '):', todayDocs);
    
    // 5. Documentos del usuario HOY
    const userTodayDocs = await collection.find({ 
      id_cli: parseInt(id_cli), 
      fecha: today 
    }).toArray();
    console.log('👤📅 Documentos del usuario hoy:', userTodayDocs);
    
    // 6. Últimos 10 documentos por timestamp
    const recentDocs = await collection.find({})
      .sort({ timestamp: -1 })
      .limit(10)
      .toArray();
    console.log('🕐 Últimos 10 documentos:', recentDocs);

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

// ENDPOINT para insertar datos de prueba
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

// Middleware para limpiar asignaciones expiradas (ejecutar cada hora)
setInterval(() => {
  const now = new Date();
  const ASSIGNMENT_TIMEOUT = 6 * 60 * 60 * 1000; // 6 horas
  
  for (const [deviceId, assignment] of connectedPedometers.entries()) {
    if (now - assignment.assigned_at > ASSIGNMENT_TIMEOUT) {
      console.log(`⏰ Liberando podómetro ${deviceId} por timeout`);
      connectedPedometers.delete(deviceId);
      
      // Notificar liberación por timeout
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

app.post('/api/iot/scale/assign', async (req, res) => {
  try {
    const { user_id, user_name, device_id } = req.body;
    
    console.log('⚖️ === ASIGNANDO BÁSCULA ===');
    console.log('📥 Datos recibidos:', { user_id, user_name, device_id });
    
    if (!user_id || !user_name) {
      return res.status(400).json({
        success: false,
        message: 'user_id y user_name son requeridos'
      });
    }
    
    // Verificar que el usuario existe
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
      
      // Crear asignación
      const assignment = {
        user_id: parseInt(user_id),
        user_name: user_name,
        device_id: deviceKey,
        assigned_at: new Date().toISOString(),
        status: 'active'
      };
      
      // Guardar asignación
      connectedScales.set(deviceKey, assignment);
      
      console.log('✅ Báscula asignada:', assignment);
      
      res.json({
        success: true,
        message: 'Usuario asignado a la báscula exitosamente',
        assignment: assignment
      });
      
    } finally {
      await connection.end();
    }
    
  } catch (error) {
    console.error('❌ Error asignando báscula:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

app.post('/api/iot/scale/release', async (req, res) => {
  try {
    const { device_id, user_id } = req.body;
    
    console.log('⚖️ === LIBERANDO BÁSCULA ===');
    console.log('📥 Datos recibidos:', { device_id, user_id });
    
    const deviceKey = device_id || 'default';
    const assignment = connectedScales.get(deviceKey);
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'No hay báscula asignada'
      });
    }
    
    // Verificar permisos
    if (user_id && assignment.user_id !== user_id) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para liberar esta báscula'
      });
    }
    
    console.log('✅ Liberando báscula de usuario:', assignment.user_name);
       // Limpiar estado
    scaleState.isWeighing = false;
    scaleState.currentFood = null;
    scaleState.targetWeight = 0;
    
    // Remover asignación
    connectedScales.delete(deviceKey);
    
    res.json({
      success: true,
      message: 'Báscula liberada exitosamente',
      former_assignment: assignment
    });
    
  } catch (error) {
    console.error('❌ Error liberando báscula:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

app.get('/api/iot/scale/assignments', (req, res) => {
  try {
    const assignments = Array.from(connectedScales.values());
    
    console.log('⚖️ === CONSULTANDO ASIGNACIONES BÁSCULA ===');
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
    console.error('❌ Error obteniendo asignaciones báscula:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo asignaciones',
      error: error.message
    });
  }
});

// GET /api/iot/scale/available - Verificar disponibilidad
app.get('/api/iot/scale/available', (req, res) => {
  try {
    const totalDevices = 2; // Simular 2 básculas disponibles
    const assignedDevices = connectedScales.size;
    const availableDevices = Math.max(0, totalDevices - assignedDevices);
    
    console.log('⚖️ === BÁSCULAS DISPONIBLES ===');
    console.log('📊 Total:', totalDevices, 'Asignadas:', assignedDevices, 'Disponibles:', availableDevices);
    
    res.json({
      success: true,
      total_devices: totalDevices,
      assigned_devices: assignedDevices,
      available_devices: availableDevices,
      devices: Array.from(connectedScales.keys())
    });
    
  } catch (error) {
    console.error('❌ Error verificando disponibilidad báscula:', error);
    res.status(500).json({
      success: false,
      message: 'Error verificando disponibilidad',
      error: error.message
    });
  }
});

// POST /api/iot/scale/start-weighing - Iniciar proceso de pesado
app.post('/api/iot/scale/start-weighing', async (req, res) => {
  try {
    const { 
      user_id,
      device_id,
      food_name,
      target_weight,
      food_calories_per_100g,
      food_info 
    } = req.body;
    
    console.log('⚖️ === INICIANDO PESADO ===');
    console.log('📥 Datos:', { user_id, food_name, target_weight });
    
    const deviceKey = device_id || 'default';
    const assignment = connectedScales.get(deviceKey);
    
    if (!assignment || assignment.user_id !== user_id) {
      return res.status(403).json({
        success: false,
        message: 'No tienes una báscula asignada'
      });
    }
    
    if (!scaleState.connected) {
      return res.status(400).json({
        success: false,
        message: 'La báscula no está conectada'
      });
    }
    
    // Configurar estado de pesado
    scaleState.isWeighing = true;
    scaleState.currentFood = {
      name: food_name,
      calories_per_100g: food_calories_per_100g,
      ...food_info
    };
    scaleState.targetWeight = parseFloat(target_weight) || 100;
    
    // Enviar comando a la báscula
    const command = {
      type: 'start_weighing',
      food_name: food_name,
      target_weight: scaleState.targetWeight,
      user_id: user_id,
      timestamp: new Date().toISOString()
    };
    
    broadcastToClients(command);
    
    console.log('✅ Pesado iniciado para:', food_name, 'objetivo:', target_weight + 'g');
    
    res.json({
      success: true,
      message: 'Proceso de pesado iniciado',
      target_weight: scaleState.targetWeight,
      current_weight: scaleState.weight,
      food_info: scaleState.currentFood
    });
    
  } catch (error) {
    console.error('❌ Error iniciando pesado:', error);
    res.status(500).json({
      success: false,
      message: 'Error iniciando proceso de pesado',
      error: error.message
    });
  }
});

app.post('/api/iot/scale/weighing-complete', (req, res) => {
  try {
    const { device_id, final_weight, timestamp } = req.body;

    console.log('✅ Pesado completado:', {
      device_id,
      final_weight,
      timestamp
    });

    // Actualizar estado
    scaleState.isWeighing = false;
    scaleState.weight = parseFloat(final_weight) || 0;
    scaleState.currentFood = null;
    scaleState.targetWeight = 0;
    scaleState.lastUpdate = new Date();

    res.json({
      success: true,
      message: 'Pesado completado registrado',
      final_weight: final_weight
    });

  } catch (error) {
    console.error('❌ Error procesando pesado completado:', error);
    res.status(500).json({
      success: false,
      message: 'Error procesando pesado completado',
      error: error.message
    });
  }
});

// POST /api/iot/scale/target-reached - Peso objetivo alcanzado (desde ESP32)
app.post('/api/iot/scale/target-reached', (req, res) => {
  try {
    const { device_id, current_weight, target_weight, timestamp } = req.body;

    console.log('🎯 Peso objetivo alcanzado:', {
      device_id,
      current_weight,
      target_weight
    });

    // Actualizar estado
    scaleState.weight = parseFloat(current_weight) || 0;
    scaleState.lastUpdate = new Date();

    // Aquí podrías notificar a la app móvil vía WebSocket o similar
    console.log(`🔔 Notificación: Peso ${current_weight}g alcanzado (objetivo: ${target_weight}g)`);

    res.json({
      success: true,
      message: 'Peso objetivo alcanzado registrado'
    });

  } catch (error) {
    console.error('❌ Error procesando peso objetivo:', error);
    res.status(500).json({
      success: false,
      message: 'Error procesando peso objetivo',
      error: error.message
    });
  }
});


// POST /api/iot/scale/stop-weighing - Detener pesado
app.post('/api/iot/scale/stop-weighing', async (req, res) => {
  try {
    const { user_id, device_id } = req.body;
    
    const deviceKey = device_id || 'default';
    const assignment = connectedScales.get(deviceKey);
    
    if (!assignment || assignment.user_id !== user_id) {
      return res.status(403).json({
        success: false,
        message: 'No autorizado'
      });
    }
    
    // Limpiar estado
    scaleState.isWeighing = false;
    scaleState.currentFood = null;
    scaleState.targetWeight = 0;
    
    // Enviar comando a la báscula
    broadcastToClients({
      type: 'stop_weighing',
      timestamp: new Date().toISOString()
    });
    
    res.json({
      success: true,
      message: 'Pesado detenido',
      final_weight: scaleState.weight
    });
    
  } catch (error) {
    console.error('❌ Error deteniendo pesado:', error);
    res.status(500).json({
      success: false,
      message: 'Error deteniendo pesado',
      error: error.message
    });
  }
});

// POST /api/iot/scale/tare - Tarar báscula
app.post('/api/iot/scale/tare', async (req, res) => {
  try {
    const { user_id, device_id } = req.body;
    
    const deviceKey = device_id || 'default';
    const assignment = connectedScales.get(deviceKey);
    
    if (!assignment || assignment.user_id !== user_id) {
      return res.status(403).json({
        success: false,
        message: 'No autorizado'
      });
    }
    
    if (!scaleState.connected) {
      return res.status(400).json({
        success: false,
        message: 'Báscula no conectada'
      });
    }
    
    // Enviar comando de tara
    broadcastToClients({
      type: 'tare_scale',
      timestamp: new Date().toISOString()
    });
    
    console.log('⚖️ Comando de tara enviado');
    
    res.json({
      success: true,
      message: 'Comando de tara enviado a la báscula'
    });
    
  } catch (error) {
    console.error('❌ Error enviando tara:', error);
    res.status(500).json({
      success: false,
      message: 'Error enviando comando de tara',
      error: error.message
    });
  }
});

setInterval(() => {
  const now = new Date();
  const ASSIGNMENT_TIMEOUT = 4 * 60 * 60 * 1000; // 4 horas para básculas
  
  for (const [deviceId, assignment] of connectedScales.entries()) {
    if (now - new Date(assignment.assigned_at) > ASSIGNMENT_TIMEOUT) {
      console.log(`⏰ Liberando báscula ${deviceId} por timeout`);
      connectedScales.delete(deviceId);
      
      // Limpiar estado si era esta báscula
      if (scaleState.isWeighing) {
        scaleState.isWeighing = false;
        scaleState.currentFood = null;
        scaleState.targetWeight = 0;
      }
      
      // Notificar liberación por timeout
      broadcastToClients({
        type: 'scale_assignment_timeout',
        device_id: deviceId,
        former_user_id: assignment.user_id
      });
    }
  }
}, 60 * 60 * 1000);

app.post('/api/iot/scale/tare-complete', (req, res) => {
  try {
    const { device_id, timestamp } = req.body;

    console.log('🔄 Tara completada:', {
      device_id,
      timestamp
    });

    // Actualizar estado
    scaleState.weight = 0;
    scaleState.calibrated = true;
    scaleState.lastUpdate = new Date();

    res.json({
      success: true,
      message: 'Tara registrada'
    });

  } catch (error) {
    console.error('❌ Error procesando tara:', error);
    res.status(500).json({
      success: false,
      message: 'Error procesando tara',
      error: error.message
    });
  }
});

app.get('/api/iot/pedometer/stats/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    const { days = 7 } = req.query;

    if (!mongoDB) {
      return res.status(500).json({
        success: false,
        message: 'MongoDB no está disponible'
      });
    }

    const collection = mongoDB.collection('actividad_pasos');

    // Obtener estadísticas de los últimos N días
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - parseInt(days));

    const pipeline = [
      {
        $match: {
          id_cli: parseInt(id_cli),
          fecha: {
            $gte: startDate.toISOString().split('T')[0],
            $lte: endDate.toISOString().split('T')[0]
          }
        }
      },
      {
        $group: {
          _id: null,
          total_pasos: { $sum: "$pasos" },
          total_calorias: { $sum: "$calorias_gastadas" },
          total_distancia: { $sum: "$distancia_km" },
          dias_activos: { $sum: 1 },
          promedio_pasos: { $avg: "$pasos" },
          max_pasos: { $max: "$pasos" },
          min_pasos: { $min: "$pasos" }
        }
      }
    ];

    const [stats] = await collection.aggregate(pipeline).toArray();

    // Obtener datos diarios para el gráfico
    const dailyData = await collection
      .find({
        id_cli: parseInt(id_cli),
        fecha: {
          $gte: startDate.toISOString().split('T')[0],
          $lte: endDate.toISOString().split('T')[0]
        }
      })
      .sort({ fecha: 1 })
      .toArray();

    // Verificar si hay asignación activa
    const assignment = connectedPedometers.get('thingspeak_device');
    const isAssigned = assignment && assignment.user_id === parseInt(id_cli);

    res.json({
      success: true,
      user_id: parseInt(id_cli),
      period_days: parseInt(days),
      is_assigned_to_pedometer: isAssigned,
      assignment_info: isAssigned ? assignment : null,
      summary: stats || {
        total_pasos: 0,
        total_calorias: 0,
        total_distancia: 0,
        dias_activos: 0,
        promedio_pasos: 0,
        max_pasos: 0,
        min_pasos: 0
      },
      daily_data: dailyData,
      thingspeak_sync: {
        source: 'thingspeak',
        channel_id: THINGSPEAK_CONFIG.CHANNEL_ID,
        last_sync: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Error obteniendo estadísticas de pasos:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo estadísticas',
      error: error.message
    });
  }
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

app.get('/api/mysql-test', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT NOW() AS now');
    res.json({ success: true, now: rows[0].now });
  } catch (err) {
    console.error('❌ Error conexión MySQL:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// Actualizar tu endpoint de login para manejar ambos formatos

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
        'SELECT id_admin as id, tipo_usu, nombre_admin as nombre, correo, password FROM administradores WHERE correo = ?',
        [correo]
      );

      if (adminResults.length > 0) {
        user = adminResults[0];
        userType = 'admin';
      }

      // Buscar en nutriólogos si no se encontró admin
      if (!user) {
        const [nutResults] = await connection.execute(
          'SELECT id_nut as id, tipo_usu, CONCAT(nombre_nut, " ", app_nut, " ", apm_nut) as nombre, correo, password, cedula_nut, especialidad_nut, telefono_nut, activo, tiene_acceso FROM nutriologos WHERE correo = ?',
          [correo]
        );

        if (nutResults.length > 0) {
          user = nutResults[0];
          userType = 'nutriologo';
        }
      }

      // Buscar en clientes si no se encontró nutriólogo
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

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Credenciales inválidas'
        });
      }

      // ✅ VERIFICACIÓN DE CONTRASEÑA MEJORADA
      let passwordMatch = false;
      
      // Verificar si la contraseña está hasheada
      const isHashedPassword = user.password.startsWith('$2b$') || user.password.startsWith('$2a$');
      
      if (isHashedPassword) {
        // Contraseña hasheada - usar bcrypt.compare
        console.log('🔐 Verificando contraseña hasheada...');
        passwordMatch = await bcrypt.compare(password, user.password);
      } else {
        // Contraseña en texto plano - comparación directa (temporal)
        console.log('⚠️ Contraseña sin hashear detectada - comparación directa');
        passwordMatch = (password === user.password);
        
        // OPCIONAL: Hashear automáticamente la contraseña después del login exitoso
        if (passwordMatch) {
          console.log('🔐 Hasheando contraseña automáticamente...');
          try {
            const hashedPassword = await bcrypt.hash(password, 10);
            
            if (userType === 'admin') {
              await connection.execute(
                'UPDATE administradores SET password = ? WHERE id_admin = ?',
                [hashedPassword, user.id]
              );
            } else if (userType === 'nutriologo') {
              await connection.execute(
                'UPDATE nutriologos SET password = ? WHERE id_nut = ?',
                [hashedPassword, user.id]
              );
            } else if (userType === 'cliente') {
              await connection.execute(
                'UPDATE clientes SET password_cli = ? WHERE id_cli = ?',
                [hashedPassword, user.id]
              );
            }
            
            console.log(`✅ Contraseña hasheada automáticamente para ${userType} ${user.id}`);
          } catch (hashError) {
            console.error('❌ Error hasheando automáticamente:', hashError);
          }
        }
      }

      if (!passwordMatch) {
        return res.status(401).json({
          success: false,
          message: 'Credenciales inválidas'
        });
      }

      // Verificar estado del usuario (resto del código sin cambios)
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

    } finally {
      await connection.end();
    }

  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
});

app.post('/api/admin/hash-passwords', async (req, res) => {
  try {
    console.log('🔐 === INICIANDO PROCESO DE HASHEO ===');
    
    const { secret_key } = req.body;
    
    // Verificar clave secreta para seguridad
    if (secret_key !== 'HASH_PASSWORDS_SECRET_2025') {
      return res.status(403).json({
        success: false,
        message: 'Clave secreta incorrecta'
      });
    }

    const adminsToUpdate = [
      { id: 1, password: 'NutrAlis123' },
      { id: 2, password: 'NutrAlis123' },
      { id: 3, password: 'NutrAlis123' },
    ];

    const connection = await mysql.createConnection(dbConfig);
    const results = [];

    try {
      for (const admin of adminsToUpdate) {
        try {
          console.log(`🔐 Hasheando contraseña para admin ${admin.id}...`);
          
          // Hashear la contraseña
          const hashedPassword = await bcrypt.hash(admin.password, 10);
          
          // Actualizar en la base de datos
          const [result] = await connection.execute(
            'UPDATE administradores SET password = ? WHERE id_admin = ?',
            [hashedPassword, admin.id]
          );

          if (result.affectedRows > 0) {
            console.log(`✅ Contraseña actualizada para admin ${admin.id}`);
            results.push({
              admin_id: admin.id,
              status: 'success',
              message: 'Contraseña hasheada exitosamente'
            });
          } else {
            console.log(`⚠️ Admin ${admin.id} no encontrado`);
            results.push({
              admin_id: admin.id,
              status: 'not_found',
              message: 'Administrador no encontrado'
            });
          }

        } catch (hashError) {
          console.error(`❌ Error hasheando admin ${admin.id}:`, hashError);
          results.push({
            admin_id: admin.id,
            status: 'error',
            message: hashError.message
          });
        }
      }

      console.log('🔐 === PROCESO DE HASHEO COMPLETADO ===');

      res.json({
        success: true,
        message: 'Proceso de hasheo completado',
        results: results,
        total_processed: adminsToUpdate.length,
        successful: results.filter(r => r.status === 'success').length
      });

    } finally {
      await connection.end();
    }

  } catch (error) {
    console.error('❌ Error en proceso de hasheo:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
    });
  }
});

// GET /api/admin/verify-passwords - Verificar si las contraseñas están hasheadas
app.get('/api/admin/verify-passwords', async (req, res) => {
  try {
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [admins] = await connection.execute(
        'SELECT id_admin, password FROM administradores WHERE id_admin IN (1, 2, 3)'
      );

      const verification = admins.map(admin => {
        const isHashed = admin.password.startsWith('$2b$') || admin.password.startsWith('$2a$');
        return {
          admin_id: admin.id_admin,
          password_length: admin.password.length,
          is_hashed: isHashed,
          password_preview: admin.password.substring(0, 10) + '...'
        };
      });

      res.json({
        success: true,
        admins: verification,
        all_hashed: verification.every(v => v.is_hashed)
      });

    } finally {
      await connection.end();
    }

  } catch (error) {
    console.error('❌ Error verificando contraseñas:', error);
    res.status(500).json({
      success: false,
      message: 'Error verificando contraseñas',
      error: error.message
    });
  }
});

// POST /api/admin/hash-single-password - Hashear una contraseña individual
app.post('/api/admin/hash-single-password', async (req, res) => {
  try {
    const { password, user_type, user_id, secret_key } = req.body;
    
    if (secret_key !== 'HASH_PASSWORDS_SECRET_2025') {
      return res.status(403).json({
        success: false,
        message: 'Clave secreta incorrecta'
      });
    }

    if (!password || !user_type || !user_id) {
      return res.status(400).json({
        success: false,
        message: 'Faltan parámetros: password, user_type, user_id'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const connection = await mysql.createConnection(dbConfig);

    try {
      let query = '';
      let params = [hashedPassword, user_id];

      switch (user_type) {
        case 'admin':
          query = 'UPDATE administradores SET password = ? WHERE id_admin = ?';
          break;
        case 'nutriologo':
          query = 'UPDATE nutriologos SET password = ? WHERE id_nut = ?';
          break;
        case 'cliente':
          query = 'UPDATE clientes SET password_cli = ? WHERE id_cli = ?';
          break;
        default:
          throw new Error('Tipo de usuario no válido');
      }

      const [result] = await connection.execute(query, params);

      if (result.affectedRows > 0) {
        res.json({
          success: true,
          message: `Contraseña hasheada para ${user_type} ${user_id}`,
          hash_preview: hashedPassword.substring(0, 20) + '...'
        });
      } else {
        res.status(404).json({
          success: false,
          message: 'Usuario no encontrado'
        });
      }

    } finally {
      await connection.end();
    }

  } catch (error) {
    console.error('❌ Error hasheando contraseña individual:', error);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: error.message
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

      let sexo_db;
      if (sexo_cli === 'm') {
        sexo_db = 'hombre';
      } else if (sexo_cli === 'f') {
        sexo_db = 'mujer';
        } else {
          return res.status(400).json({
            success: false,
            message: 'El campo sexo_cli debe ser "m" o "f"'
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
          edad_cli, sexo_db, peso_cli, estatura_cli, faf_cli || 1.2, geb_cli || 0,
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


//APIS WEB
// AGREGAR este endpoint específico para el login web
app.post('/api/nutriologos/login', async (req, res) => {
  try {
    console.log('🔐 === LOGIN WEB NUTRIÓLOGOS ===');
    const { correo, password } = req.body;

    if (!correo || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email y contraseña son requeridos'
      });
    }

    const connection = await mysql.createConnection(dbConfig);
    let user = null;
    let userType = null;

    try {
      // Buscar en nutriólogos
      const [nutriResults] = await connection.execute(
        `SELECT id_nut AS id, nombre_nut AS nombre, password, verificado, tiene_acceso, tipo_usu, activo
         FROM nutriologos WHERE correo = ?`,
        [correo]
      );

      if (nutriResults.length > 0) {
        user = nutriResults[0];
        userType = 'nutriologo';
      }

      // Si no se encuentra en nutriólogos, buscar en administradores
      if (!user) {
        const [adminResults] = await connection.execute(
          `SELECT id_admin AS id, nombre_admin AS nombre, password, tipo_usu
           FROM administradores WHERE correo = ?`,
          [correo]
        );

        if (adminResults.length > 0) {
          user = adminResults[0];
          userType = 'admin';
          // Los admins no tienen verificado ni tiene_acceso
          user.verificado = 'aprobado';
          user.activo = 1;
        }
      }

      if (!user) {
        console.log('❌ Usuario no encontrado:', correo);
        return res.status(404).json({
          success: false,
          error: 'Correo no registrado'
        });
      }

      console.log('👤 Usuario encontrado:', {
        id: user.id,
        nombre: user.nombre,
        userType,
        verificado: user.verificado,
        tiene_acceso: user.tiene_acceso,
        activo: user.activo
      });

      // ✅ VERIFICAR ESTADO DEL USUARIO ANTES DE VALIDAR CONTRASEÑA
      if (userType === 'nutriologo') {
        if (user.verificado === 'pendiente') {
          console.log('⚠️ Usuario pendiente de aprobación');
          return res.status(403).json({
            success: false,
            error: 'Solicitud de registro aún no ha sido aprobada. Intenta más tarde.'
          });
        }
        
        if (user.verificado === 'denegado') {
          console.log('❌ Usuario denegado');
          return res.status(403).json({
            success: false,
            error: 'Solicitud de registro denegada. Si crees que se trata de un error favor de comunicarse con soporte através de nutralis@gmail.com'
          });
        }

        if (!user.activo) {
          console.log('❌ Usuario inactivo');
          return res.status(403).json({
            success: false,
            error: 'Cuenta desactivada'
          });
        }

        
      }

      // ✅ VERIFICACIÓN DE CONTRASEÑA
      let passwordMatch = false;
      
      // Verificar si la contraseña está hasheada
      const isHashedPassword = user.password.startsWith('$2b$') || user.password.startsWith('$2a$');
      
      if (isHashedPassword) {
        // Contraseña hasheada - usar bcrypt.compare
        console.log('🔐 Verificando contraseña hasheada...');
        passwordMatch = await bcrypt.compare(password, user.password);
        console.log('🔐 Resultado verificación:', passwordMatch);
      } else {
        // Contraseña en texto plano - comparación directa
        console.log('⚠️ Contraseña sin hashear detectada - comparación directa');
        passwordMatch = (password === user.password);
        console.log('🔐 Resultado comparación directa:', passwordMatch);
        
        // Hashear automáticamente la contraseña después del login exitoso
        if (passwordMatch) {
          console.log('🔐 Hasheando contraseña automáticamente...');
          try {
            const hashedPassword = await bcrypt.hash(password, 10);
            
            if (userType === 'admin') {
              await connection.execute(
                'UPDATE administradores SET password = ? WHERE id_admin = ?',
                [hashedPassword, user.id]
              );
            } else if (userType === 'nutriologo') {
              await connection.execute(
                'UPDATE nutriologos SET password = ? WHERE id_nut = ?',
                [hashedPassword, user.id]
              );
            }
            
            console.log(`✅ Contraseña hasheada automáticamente para ${userType} ${user.id}`);
          } catch (hashError) {
            console.error('❌ Error hasheando automáticamente:', hashError);
          }
        }
      }

      if (!passwordMatch) {
        console.log('❌ Contraseña incorrecta');
        return res.status(401).json({
          success: false,
          error: 'Contraseña incorrecta'
        });
      }

      // Generar token de sesión
      const newToken = uuidv4();
      
      if (userType === 'admin') {
        await connection.execute(
          `UPDATE administradores SET token = ? WHERE id_admin = ?`,
          [newToken, user.id]
        );
      } else {
        await connection.execute(
          `UPDATE nutriologos SET token = ? WHERE id_nut = ?`,
          [newToken, user.id]
        );
      }

      console.log('✅ Login exitoso para:', user.nombre);

      res.json({
        success: true,
        message: `Inicio de sesión exitoso (${userType})`,
        id_nut: user.id,
        nombre: user.nombre,
        token: newToken,
        tipo_usu: user.tipo_usu || (userType === 'admin' ? 0 : 1),
        rol: userType
      });

    } finally {
      await connection.end();
    }

  } catch (error) {
    console.error('❌ Error en login web:', error);
    res.status(500).json({
      success: false,
      error: 'Error en el servidor'
    });
  }
});

// Mantén también el endpoint de login de Google corregido
app.post('/api/nutriologos/login-google', async (req, res) => {
  try {
    const { correo, nombre } = req.body;
    if (!correo) return res.status(400).json({ error: 'Correo requerido' });

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT id_nut AS id, nombre_nut AS nombre, verificado, tiene_acceso, tipo_usu, activo
         FROM nutriologos WHERE correo = ?`,
        [correo]
      );

      if (results.length > 0) {
        const nutri = results[0];

        // Verificar estados ANTES de proceder
        if (nutri.verificado === 'pendiente') {
          return res.status(403).json({ 
            success: false,
            error: 'Solicitud de registro aún no aprobada.' 
          });
        }

        if (nutri.verificado === 'denegado') {
          return res.status(403).json({ 
            success: false,
            error: 'Solicitud de registro denegada.' 
          });
        }

        if (!nutri.activo) {
          return res.status(403).json({ 
            success: false,
            error: 'Cuenta desactivada.' 
          });
        }

        if (!nutri.tiene_acceso) {
          return res.status(403).json({ 
            success: false,
            error: 'No tienes acceso en este momento' 
          });
        }

        const newToken = uuidv4();
        await connection.execute(
          `UPDATE nutriologos SET token = ? WHERE id_nut = ?`, 
          [newToken, nutri.id]
        );

        res.json({
          success: true,
          message: 'Inicio de sesión exitoso (nutriólogo)',
          id_nut: nutri.id,
          nombre: nutri.nombre,
          token: newToken,
          tipo_usu: nutri.tipo_usu,
          rol: 'nutriologo',
        });
      } else {
        res.status(404).json({ 
          success: false,
          error: 'Usuario no registrado, favor registrarse' 
        });
      }
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error en login Google:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error en el servidor' 
    });
  }
});

app.post('/api/nutriologos/logout', async (req, res) => {
  try {
    const { id, rol } = req.body;

    if (!id || !rol) {
      return res.status(400).json({ error: 'Datos incompletos para cerrar sesión' });
    }

    const tabla = rol === 'admin' ? 'administradores' : 'nutriologos';
    const campo = rol === 'admin' ? 'id_admin' : 'id_nut';

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [result] = await connection.execute(
        `UPDATE ${tabla} SET token = NULL WHERE ${campo} = ?`,
        [id]
      );
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      
      res.json({ message: 'Sesión cerrada correctamente' });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error en logout:', error);
    res.status(500).json({ error: 'Error al cerrar sesión' });
  }
});

//registro web
app.post('/api/nutriologos/registro', async (req, res) => {
  try {
    const {
      nombre_nut,
      app_nut,
      apm_nut,
      correo,
      password,
      cedula_nut,
      especialidad_nut,
      telefono_nut,
      token_vinculacion
    } = req.body;

    console.log('📝 Datos recibidos para registro de nutriólogo:', req.body);

    // Validar campos obligatorios
    if (!nombre_nut || !app_nut || !correo || !password || !cedula_nut || !telefono_nut) {
      console.log('❌ Faltan datos obligatorios');
      return res.status(400).json({
        success: false,
        error: 'Faltan datos obligatorios: nombre, apellido paterno, correo, contraseña, cédula y teléfono son requeridos'
      });
    }

    // Validar formato de correo
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(correo)) {
      return res.status(400).json({
        success: false,
        error: 'Formato de correo electrónico inválido'
      });
    }

    // Validar longitud de contraseña
    if (password.length < 5) {
      return res.status(400).json({
        success: false,
        error: 'La contraseña debe tener al menos 5 caracteres'
      });
    }

    const connection = await mysql.createConnection(dbConfig);

    try {
      // Verificar si el correo ya existe
      const [existingUser] = await connection.execute(
        'SELECT correo FROM nutriologos WHERE correo = ?',
        [correo]
      );

      if (existingUser.length > 0) {
        console.log('❌ Correo ya registrado:', correo);
        return res.status(409).json({
          success: false,
          error: 'Este correo electrónico ya está registrado'
        });
      }

      // Verificar si la cédula ya existe
      const [existingCedula] = await connection.execute(
        'SELECT cedula_nut FROM nutriologos WHERE cedula_nut = ?',
        [cedula_nut]
      );

      if (existingCedula.length > 0) {
        console.log('❌ Cédula ya registrada:', cedula_nut);
        return res.status(409).json({
          success: false,
          error: 'Esta cédula profesional ya está registrada'
        });
      }

      // Verificar si el token ya existe (si se proporciona)
      if (token_vinculacion) {
        const [existingToken] = await connection.execute(
          'SELECT token_vinculacion FROM nutriologos WHERE token_vinculacion = ?',
          [token_vinculacion]
        );

        if (existingToken.length > 0) {
          console.log('❌ Token ya existe, generando uno nuevo');
          token_vinculacion = `AUTO${Date.now()}${Math.floor(Math.random() * 1000)}`;
        }
      }

      // Insertar el nuevo nutriólogo usando los campos exactos de tu tabla
      const [result] = await connection.execute(
        `INSERT INTO nutriologos (
          tipo_usu, nombre_nut, app_nut, apm_nut, correo, password, 
          cedula_nut, especialidad_nut, telefono_nut, token_vinculacion,
          activo, tiene_acceso, verificado
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          1, // tipo_usu: 1 para nutriólogos
          nombre_nut,
          app_nut,
          apm_nut || '', // apm_nut puede ser vacío
          correo,
          password, // En producción, deberías hashear la contraseña
          cedula_nut,
          especialidad_nut || null, // especialidad_nut es opcional
          telefono_nut,
          token_vinculacion || `AUTO${Date.now()}${Math.floor(Math.random() * 1000)}`,
          1, // activo: 1 (verdadero)
          0, // tiene_acceso: 0 (falso) hasta que sea aprobado
          'pendiente' // verificado: pendiente por defecto
        ]
      );

      console.log('✅ Nutriólogo registrado exitosamente. ID:', result.insertId);

      res.status(201).json({
        success: true,
        message: 'Registro exitoso. Tu solicitud está pendiente de aprobación.',
        nutriologoId: result.insertId,
        status: 'pending_approval'
      });

    } finally {
      await connection.end();
    }

  } catch (error) {
    console.error('❌ Error en registro de nutriólogo:', error);
    
    // Manejar errores específicos de MySQL
    if (error.code === 'ER_DUP_ENTRY') {
      if (error.message.includes('correo')) {
        return res.status(409).json({
          success: false,
          error: 'Este correo electrónico ya está registrado'
        });
      } else if (error.message.includes('token_vinculacion')) {
        return res.status(409).json({
          success: false,
          error: 'Error con el token de vinculación. Intenta de nuevo.'
        });
      }
    }
    
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor. Intenta de nuevo más tarde.'
    });
  }
});

app.get('/api/nutriologos', async (req, res) => {
  try {
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [rows] = await connection.execute('SELECT * FROM nutriologos ORDER BY id_nut DESC');
      res.json(rows);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error en /nutriologos:', error);
    res.status(500).json({ message: 'Error en el servidor' });
  }
});

app.put('/api/nutriologos/:id/verificar', async (req, res) => {
  try {
    const id = req.params.id;
    const fechaHoy = new Date().toISOString().split('T')[0];

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [result] = await connection.execute(
        `UPDATE nutriologos
         SET verificado = ?, fecha_inicio_sub = IF(fecha_inicio_sub IS NULL, ?, fecha_inicio_sub), tiene_acceso = 1
         WHERE id_nut = ?`,
        ['aprobado', fechaHoy, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Nutriólogo no encontrado' });
      }

      res.json({ message: 'Nutriólogo aprobado correctamente' });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error al aprobar nutriólogo:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

app.put('/api/nutriologos/:id/denegar', async (req, res) => {
  try {
    const id = req.params.id;

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [result] = await connection.execute(
        `UPDATE nutriologos SET verificado = 'denegado', tiene_acceso = 0 WHERE id_nut = ?`,
        [id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: 'Nutriólogo no encontrado' });
      }

      res.json({ message: 'Nutriólogo rechazado correctamente' });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error al denegar nutriólogo:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
});

app.get('/api/nutriologos/info/:id', async (req, res) => {
  try {
    const idNut = req.params.id;

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT id_nut, tipo_usu, nombre_nut, app_nut, apm_nut, correo, password, 
         cedula_nut, especialidad_nut, telefono_nut, token_vinculacion, activo, 
         fecha_inicio_sub, fecha_fin_sub, tiene_acceso, verificado
         FROM nutriologos WHERE id_nut = ?`,
        [idNut]
      );

      if (results.length === 0) {
        return res.status(404).json({ error: 'Nutriólogo no encontrado' });
      }

      res.json(results[0]);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error obteniendo info nutriólogo:', error);
    res.status(500).json({ error: 'Error en base de datos' });
  }
});

app.get('/api/nutriologos/detalle/:id', async (req, res) => {
  try {
    const idNut = req.params.id;

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT id_nut, tipo_usu, nombre_nut, app_nut, apm_nut, correo, cedula_nut, 
         especialidad_nut, telefono_nut, fecha_inicio_sub, fecha_fin_sub, 
         token_vinculacion, tiene_acceso, verificado
         FROM nutriologos WHERE id_nut = ?`,
        [idNut]
      );

      if (results.length === 0) {
        return res.status(404).json({ error: 'Nutriólogo no encontrado' });
      }

      res.json(results[0]);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error obteniendo detalle nutriólogo:', error);
    res.status(500).json({ error: 'Error en base de datos' });
  }
});

app.get('/api/obdietas/:id_cliente', async (req, res) => {
  try {
    const idCliente = req.params.id_cliente;
    
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT * FROM dietas WHERE id_cli = ? ORDER BY fecha_inicio DESC`,
        [idCliente]
      );
      
      res.json(results);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error al obtener dietas por cliente:', error);
    res.status(500).json({ error: 'Error al obtener las dietas del cliente' });
  }
});

app.post("/api/clientes-por-nutriologo", async (req, res) => {
  try {
    const { idNutriologo } = req.body;

    if (!idNutriologo || isNaN(idNutriologo)) {
      return res.status(400).json({ error: "ID de nutriólogo inválido" });
    }

    const connection = await mysql.createConnection(dbConfig);

    try {
      const [clientes] = await connection.execute(
        `SELECT 
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
          c.id_cli, f.fecha_envio DESC`,
        [idNutriologo]
      );

      // Agrupar los antecedentes médicos por cliente
      const clientesAgrupados = clientes.reduce((acc, row) => {
        if (!acc[row.id_cli]) {
          acc[row.id_cli] = {
            ...row,
            antecedentes: []
          };
          // Eliminar campos del formulario para evitar repetición
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
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error("Error obteniendo clientes:", error);
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

app.post('/api/cliente-detalle', async (req, res) => {
  try {
    const { idCliente } = req.body;

    if (!idCliente || isNaN(idCliente)) {
      return res.status(400).json({ error: 'ID de cliente inválido' });
    }

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [clienteResults] = await connection.execute(
        `SELECT id_cli, tipo_usu, nombre_cli, app_cli, apm_cli, correo_cli, edad_cli, 
         sexo_cli, peso_cli, estatura_cli, faf_cli, geb_cli, modo, id_nut, 
         fecha_inicio_pago, fecha_fin_pago, tiene_acceso
         FROM clientes WHERE id_cli = ?`,
        [idCliente]
      );

      if (clienteResults.length === 0) {
        return res.status(404).json({ error: 'Cliente no encontrado' });
      }

      const [antecedentesResults] = await connection.execute(
        `SELECT 
      id AS id_formulario,
      motivo, 
      antecedentes_heredofamiliares, 
      antecedentes_personales_no_patologicos, 
      antecedentes_personales_patologicos, 
      alergias_intolerancias, 
      aversiones_alimentarias, 
      fecha_envio AS fecha_registro
    FROM formularios_nutricion
    WHERE id_cliente = ?`,
        [idCliente]
      );

      const cliente = clienteResults[0];
      cliente.antecedentes_medicos = antecedentesResults;

      res.json(cliente);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error obteniendo detalle cliente:', error);
    res.status(500).json({ error: 'Error al obtener datos del cliente' });
  }
}); 

app.post('/api/cliente-detalle', async (req, res) => {
  try {
    const { idCliente } = req.body;

    if (!idCliente || isNaN(idCliente)) {
      return res.status(400).json({ error: 'ID de cliente inválido' });
    }

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [clienteResults] = await connection.execute(
        `SELECT id_cli, tipo_usu, nombre_cli, app_cli, apm_cli, correo_cli, edad_cli, 
         sexo_cli, peso_cli, estatura_cli, faf_cli, geb_cli, modo, id_nut, 
         fecha_inicio_pago, fecha_fin_pago, tiene_acceso
         FROM clientes WHERE id_cli = ?`,
        [idCliente]
      );

      if (clienteResults.length === 0) {
        return res.status(404).json({ error: 'Cliente no encontrado' });
      }

      const [antecedentesResults] = await connection.execute(
        `SELECT id_antecedente, motivo, heredo_familiares, no_patologicos, patologicos, 
         alergias, aversiones, fecha_registro
         FROM antecedentes_medicos WHERE id_cli = ?`,
        [idCliente]
      );

      const cliente = clienteResults[0];
      cliente.antecedentes_medicos = antecedentesResults;

      res.json(cliente);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error obteniendo detalle cliente:', error);
    res.status(500).json({ error: 'Error al obtener datos del cliente' });
  }
});

app.post('/api/guardar-dieta', async (req, res) => {
  try {
    const {
      idCliente, nombreDieta, objetivoDieta, duracion, proteinas, carbohidratos, 
      grasas, caloriasObjetivo, recomendaciones, alimentosPorTiempo
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

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Insertar dieta
      const [resultadoDieta] = await connection.execute(
        `INSERT INTO dietas 
         (id_cli, nombre_dieta, objetivo_dieta, duracion, porcentaje_proteinas, 
          porcentaje_carbs, porcentaje_grasas, calorias_objetivo, recomendaciones, activo)
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

      // Desactivar otras dietas del cliente
      await connection.execute(
        `UPDATE dietas SET activo = 0 WHERE id_cli = ? AND id_dieta != ?`,
        [idCliente, idDieta]
      );

      res.json({ mensaje: 'Dieta guardada correctamente', idDieta });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error al guardar dieta:', error);
    res.status(500).json({ message: 'Error al guardar la dieta', error: error.message });
  }
});

app.post('/api/cliente/macronutrientes', async (req, res) => {
  try {
    const { idCliente, idNutriologo } = req.body;
    if (!idCliente || isNaN(idCliente)) return res.status(400).json({ error: 'ID de cliente inválido' });
    if (!idNutriologo || isNaN(idNutriologo)) return res.status(400).json({ error: 'ID de nutriólogo inválido' });

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT 'Proteínas' AS name, AVG(com.proteinas) AS value
         FROM comidas_registradas com
         INNER JOIN dietas d ON com.id_cli = d.id_cli
         INNER JOIN clientes c ON com.id_cli = c.id_cli
         WHERE com.id_cli = ? AND c.id_nut = ?
           AND com.fecha BETWEEN d.fecha_inicio AND d.fecha_fin
         UNION ALL
         SELECT 'Carbohidratos', AVG(com.carbohidratos)
         FROM comidas_registradas com
         INNER JOIN dietas d ON com.id_cli = d.id_cli
         INNER JOIN clientes c ON com.id_cli = c.id_cli
         WHERE com.id_cli = ? AND c.id_nut = ?
           AND com.fecha BETWEEN d.fecha_inicio AND d.fecha_fin
         UNION ALL
         SELECT 'Grasas', AVG(com.grasas)
         FROM comidas_registradas com
         INNER JOIN dietas d ON com.id_cli = d.id_cli
         INNER JOIN clientes c ON com.id_cli = c.id_cli
         WHERE com.id_cli = ? AND c.id_nut = ?
           AND com.fecha BETWEEN d.fecha_inicio AND d.fecha_fin`,
        [idCliente, idNutriologo, idCliente, idNutriologo, idCliente, idNutriologo]
      );

      res.json(results);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error en macronutrientes cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

// Adherencia a la dieta
app.post('/api/cliente/adherencia', async (req, res) => {
  try {
    const { idCliente, idNutriologo } = req.body;
    if (!idCliente || isNaN(idCliente)) return res.status(400).json({ error: 'ID de cliente inválido' });
    if (!idNutriologo || isNaN(idNutriologo)) return res.status(400).json({ error: 'ID de nutriólogo inválido' });

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT 
          DATE(com.fecha) AS dia,
          ROUND(SUM(com.calorias_totales) / d.calorias_objetivo * 100, 2) AS porcentaje
        FROM comidas_registradas com
        INNER JOIN clientes c ON com.id_cli = c.id_cli
        INNER JOIN dietas d ON d.id_cli = c.id_cli AND d.activo = 1
        WHERE com.id_cli = ? AND c.id_nut = ?
        GROUP BY DATE(com.fecha), d.calorias_objetivo
        ORDER BY dia ASC`,
        [idCliente, idNutriologo]
      );

      res.json(results);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error en adherencia cliente:', error);
    res.status(500).json({ error: error.message });
  }
})

// Cumplimiento de horarios
app.post('/api/cliente/horarios', async (req, res) => {
  try {
    const { idCliente, idNutriologo } = req.body;
    if (!idCliente || isNaN(idCliente)) return res.status(400).json({ error: 'ID de cliente inválido' });
    if (!idNutriologo || isNaN(idNutriologo)) return res.status(400).json({ error: 'ID de nutriólogo inválido' });

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT com.tipo_comida AS comida, AVG(CASE WHEN com.cumplido = 1 THEN 1 ELSE 0 END)*100 AS cumplido
         FROM comidas_registradas com
         INNER JOIN clientes c ON com.id_cli = c.id_cli
         WHERE com.id_cli = ? AND c.id_nut = ?
         GROUP BY com.tipo_comida`,
        [idCliente, idNutriologo]
      );

      res.json(results);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error en horarios cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

const verifyToken = async (req, res, next) => {
  const id_nut = req.headers['id_nut'];
  const token = req.headers['token'];
  const rol = req.headers['rol'];

  if (!id_nut || !token || !rol) {
    return res.status(401).json({ error: 'Faltan credenciales de autenticación' });
  }

  const tabla = rol === 'admin' ? 'administradores' : 'nutriologos';
  const campo = rol === 'admin' ? 'id_admin' : 'id_nut';

  const connection = await mysql.createConnection(dbConfig);
  
  try {
    const [results] = await connection.execute(
      `SELECT token FROM ${tabla} WHERE ${campo} = ?`,
      [id_nut]
    );

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
  } catch (error) {
    console.error('Error verificando token:', error);
    res.status(500).json({ error: 'Error en la base de datos' });
  } finally {
    await connection.end();
  }
};

//pasos web
app.get('/api/pasos/:id_cli', async (req, res) => {
  try {
    const { id_cli } = req.params;
    
    if (!mongoDB) {
      return res.status(500).json({ error: 'MongoDB no está disponible' });
    }

    const collection = mongoDB.collection('actividad_pasos');
    const pasos = await collection
      .find({ id_cli: parseInt(id_cli) })
      .sort({ fecha: 1 })
      .toArray();
      
    res.json(pasos);
  } catch (error) {
    console.error('Error al obtener pasos:', error);
    res.status(500).json({ error: 'Error al obtener datos de pasos' });
  }
});

app.post('/api/cliente/calorias', async (req, res) => {
  try {
    const { idCliente, idNutriologo } = req.body;
    if (!idCliente || isNaN(idCliente)) return res.status(400).json({ error: 'ID de cliente inválido' });
    if (!idNutriologo || isNaN(idNutriologo)) return res.status(400).json({ error: 'ID de nutriólogo inválido' });

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT DATE(com.fecha) AS dia, AVG(com.calorias_totales) AS calorias
         FROM comidas_registradas com
         INNER JOIN dietas d ON com.id_cli = d.id_cli
         INNER JOIN clientes c ON com.id_cli = c.id_cli
         WHERE com.id_cli = ? AND c.id_nut = ?
           AND com.fecha BETWEEN d.fecha_inicio AND d.fecha_fin
         GROUP BY DATE(com.fecha)
         ORDER BY dia ASC`,
        [idCliente, idNutriologo]
      );

      res.json(results);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error en calorías cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/cliente-objetivo/:id', async (req, res) => {
  try {
    const clienteId = req.params.id;

    if (!clienteId || isNaN(clienteId)) {
      return res.status(400).json({ message: 'ID inválido' });
    }

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT objetivo_dieta FROM dietas WHERE id_cli = ? AND activo = 1 LIMIT 1`,
        [clienteId]
      );

      if (results.length > 0) {
        res.json({ objetivo_dieta: results[0].objetivo_dieta });
      } else {
        res.status(404).json({ message: 'No se encontró objetivo para este cliente' });
      }
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error al obtener objetivo:', error);
    res.status(500).json({ message: 'Error en el servidor' });
  }
});

app.post('/api/clientes/dietas-activa', async (req, res) => {
  try {
    const { idNutriologo } = req.body;
    if (!idNutriologo || isNaN(idNutriologo)) {
      return res.status(400).json({ error: 'ID de nutriólogo inválido' });
    }

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT c.id_cli, CONCAT(c.nombre_cli, ' ', c.app_cli, ' ', c.apm_cli) AS nombre_completo,
         d.nombre_dieta, d.fecha_inicio, d.fecha_fin, AVG(com.calorias_totales) AS calorias_promedio,
         COUNT(com.id_comida) AS total_comidas
         FROM clientes c
         INNER JOIN dietas d ON c.id_cli = d.id_cli
         LEFT JOIN comidas_registradas com ON c.id_cli = com.id_cli
           AND com.fecha BETWEEN d.fecha_inicio AND d.fecha_fin
         WHERE CURDATE() BETWEEN DATE(d.fecha_inicio) AND DATE(d.fecha_fin)
           AND c.id_nut = ?
         GROUP BY c.id_cli, d.id_dieta
         HAVING total_comidas > 3
         ORDER BY calorias_promedio DESC`,
        [idNutriologo]
      );

      res.json(results);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error en estadísticas:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/clientes/dias-activos', async (req, res) => {
  try {
    const { idNutriologo } = req.body;
    if (!idNutriologo || isNaN(idNutriologo)) {
      return res.status(400).json({ error: 'ID de nutriólogo inválido' });
    }

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT c.id_cli, CONCAT(c.nombre_cli, ' ', c.app_cli, ' ', c.apm_cli) AS nombre_completo,
         d.nombre_dieta, DATEDIFF(IF(d.fecha_fin > CURDATE(), CURDATE(), d.fecha_fin), d.fecha_inicio) AS dias_actividad
         FROM clientes c
         INNER JOIN dietas d ON c.id_cli = d.id_cli
         WHERE CURDATE() BETWEEN DATE(d.fecha_inicio) AND DATE(d.fecha_fin) AND c.id_nut = ?
         ORDER BY dias_actividad DESC`,
        [idNutriologo]
      );

      res.json(results);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error en estadísticas días activos:', error);
    res.status(500).json({ error: error.message });
  }
});
app.post('/api/clientes/superan-objetivo', async (req, res) => {
  try {
    const { idNutriologo } = req.body;
    if (!idNutriologo || isNaN(idNutriologo)) {
      return res.status(400).json({ error: 'ID de nutriólogo inválido' });
    }

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT c.id_cli, CONCAT(c.nombre_cli, ' ', c.app_cli, ' ', c.apm_cli) AS nombre_completo,
         d.calorias_objetivo,
         (SELECT AVG(com.calorias_totales)
          FROM comidas_registradas com
          WHERE com.id_cli = c.id_cli
            AND com.fecha BETWEEN d.fecha_inicio AND d.fecha_fin) AS calorias_consumidas
         FROM clientes c
         INNER JOIN dietas d ON c.id_cli = d.id_cli
         WHERE CURDATE() BETWEEN DATE(d.fecha_inicio) AND DATE(d.fecha_fin)
           AND c.id_nut = ?
         HAVING calorias_consumidas > calorias_objetivo
         ORDER BY calorias_consumidas DESC`,
        [idNutriologo]
      );

      res.json(results);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error en clientes que superan objetivo:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/cliente/info-basica', async (req, res) => {
  try {
    const { idCliente, idNutriologo } = req.body;
    if (!idCliente || isNaN(idCliente)) return res.status(400).json({ error: 'ID de cliente inválido' });
    if (!idNutriologo || isNaN(idNutriologo)) return res.status(400).json({ error: 'ID de nutriólogo inválido' });

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT c.id_cli, CONCAT(c.nombre_cli, ' ', c.app_cli, ' ', c.apm_cli) AS nombre_completo,
         c.edad_cli, d.nombre_dieta, d.objetivo_dieta, d.fecha_inicio, d.fecha_fin,
         DATEDIFF(IF(d.fecha_fin > CURDATE(), CURDATE(), d.fecha_fin), d.fecha_inicio) AS dias_actividad
         FROM clientes c
         LEFT JOIN dietas d ON c.id_cli = d.id_cli
         WHERE c.id_cli = ? AND c.id_nut = ?
           AND CURDATE() BETWEEN DATE(d.fecha_inicio) AND DATE(d.fecha_fin)`,
        [idCliente, idNutriologo]
      );

      if (results.length === 0) {
        return res.status(404).json({ error: 'Cliente no encontrado o sin dieta activa' });
      }

      res.json(results[0]);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error en info básica cliente:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/clientes/resumen-sexo-modo', async (req, res) => {
  try {
    const { idNutriologo } = req.body;
    if (!idNutriologo || isNaN(idNutriologo)) {
      return res.status(400).json({ error: 'ID de nutriólogo inválido' });
    }

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [results] = await connection.execute(
        `SELECT sexo_cli, COUNT(id_cli) AS total_clientes, AVG(edad_cli) AS edad_promedio
         FROM clientes WHERE id_nut = ?
         GROUP BY sexo_cli ORDER BY total_clientes DESC`,
        [idNutriologo]
      );

      res.json(results);
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error en resumen por sexo:', error);
    res.status(500).json({ error: error.message });
  }
});

//Paypal
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

// Crear pago PayPal
app.post('/api/crear-pago', async (req, res) => {
  try {
    const { id_nut, monto, metodo_pago } = req.body;

    if (!id_nut || !monto || !metodo_pago) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

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

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [result] = await connection.execute(
        'INSERT INTO pagos_nutriologos (id_nut, monto, fecha_pago, metodo_pago, estado) VALUES (?, ?, ?, ?, ?)',
        [id_nut, monto, fecha_pago, metodo_pago, 'pendiente']
      );

      res.json({
        mensaje: 'Pago creado',
        id_pago: result.insertId,
        orden_paypal: orden,
      });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error PayPal:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error con PayPal', detalle: error.message });
  }
});

// Capturar pago PayPal
app.post('/api/capturar-pago', async (req, res) => {
  try {
    const { orderID, id_pago } = req.body;

    if (!orderID || !id_pago) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

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

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Actualizar estado del pago
      await connection.execute(
        'UPDATE pagos_nutriologos SET estado = ? WHERE id_pago = ?',
        [estado, id_pago]
      );

      // Si fue exitoso, actualizar suscripción
      if (estado === 'exitoso') {
        const [rows] = await connection.execute(
          'SELECT fecha_pago, id_nut FROM pagos_nutriologos WHERE id_pago = ?',
          [id_pago]
        );

        const { fecha_pago, id_nut } = rows[0];

        await connection.execute(
          'UPDATE nutriologos SET fecha_inicio_sub = ?, tiene_acceso = 1 WHERE id_nut = ?',
          [fecha_pago, id_nut]
        );
      }

      res.json({
        mensaje: estado === 'exitoso' ? 'Pago actualizado y suscripción registrada' : 'Pago actualizado',
        estado,
        detalle: captureResponse.data,
      });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error al capturar pago:', error.response?.data || error.message);
    res.status(500).json({ error: 'Error al capturar pago', detalle: error.message });
  }
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