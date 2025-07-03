// Cargar variables de entorno primero
require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const axios = require('axios');

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
    'http://10.13.9.202:8081'
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

// Configuración de base de datos
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'andyy2102',
  database: 'nutralis'
};

// Configuración de PayPal
const PAYPAL_CONFIG = {
  CLIENT_ID: process.env.PAYPAL_CLIENT_ID || 'AfroCxZK7B3gN_e8TZN3PyeQkgbC-FW9tWHgQgrH-cicjODbTl3VussG62l7HlrQFc5ocpPs1BaRWL89',
  CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET || 'ECw9oGgHqfkytGVDBqSuyjK6vLczjwOPKR849yAC3IP52-6bdBnh1QpaNI-qqw8BRFLaKIdF8p8xfXwy',
  BASE_URL: process.env.NODE_ENV === 'production' 
    ? 'https://api.paypal.com' 
    : 'https://api.sandbox.paypal.com'
};

// Validar configuración de PayPal al iniciar
console.log('🔍 Verificando configuración PayPal...');
if (!PAYPAL_CONFIG.CLIENT_ID || PAYPAL_CONFIG.CLIENT_ID === 'REEMPLAZA_CON_TU_CLIENT_ID') {
  console.error('❌ PAYPAL_CLIENT_ID no configurado');
}
if (!PAYPAL_CONFIG.CLIENT_SECRET || PAYPAL_CONFIG.CLIENT_SECRET === 'REEMPLAZA_CON_TU_CLIENT_SECRET') {
  console.error('❌ PAYPAL_CLIENT_SECRET no configurado');
}
console.log('✅ Configuración PayPal verificada');

// Función para obtener token de acceso de PayPal
async function getPayPalAccessToken() {
  try {
    console.log('🔑 Obteniendo token de PayPal...');
    console.log('🌐 URL:', PAYPAL_CONFIG.BASE_URL);
    console.log('🆔 Client ID:', PAYPAL_CONFIG.CLIENT_ID.substring(0, 10) + '...');
    
    const auth = Buffer.from(`${PAYPAL_CONFIG.CLIENT_ID}:${PAYPAL_CONFIG.CLIENT_SECRET}`).toString('base64');
    
    const response = await axios.post(`${PAYPAL_CONFIG.BASE_URL}/v1/oauth2/token`, 
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    console.log('✅ Token de PayPal obtenido exitosamente');
    return response.data.access_token;
  } catch (error) {
    console.error('❌ Error obteniendo token de PayPal:', error.response?.data || error.message);
    throw new Error('Error al conectar con PayPal');
  }
}

// Endpoint de debugging para PayPal
app.get('/api/paypal/debug', async (req, res) => {
  try {
    console.log('🔍 DEBUG PAYPAL');
    
    // Verificar credenciales
    const credentialsOK = !!(PAYPAL_CONFIG.CLIENT_ID && PAYPAL_CONFIG.CLIENT_SECRET);
    console.log('✅ Credenciales configuradas:', credentialsOK);
    
    if (!credentialsOK) {
      return res.json({
        success: false,
        message: 'Credenciales no configuradas',
        config: {
          CLIENT_ID: PAYPAL_CONFIG.CLIENT_ID !== 'REEMPLAZA_CON_TU_CLIENT_ID' ? 'Configurado' : 'NO configurado',
          CLIENT_SECRET: PAYPAL_CONFIG.CLIENT_SECRET !== 'REEMPLAZA_CON_TU_CLIENT_SECRET' ? 'Configurado' : 'NO configurado',
          BASE_URL: PAYPAL_CONFIG.BASE_URL
        }
      });
    }

    // Probar autenticación
    const accessToken = await getPayPalAccessToken();
    
    res.json({
      success: true,
      message: 'PayPal configurado correctamente',
      config: {
        BASE_URL: PAYPAL_CONFIG.BASE_URL,
        CLIENT_ID_PREVIEW: PAYPAL_CONFIG.CLIENT_ID.substring(0, 10) + '...',
        TOKEN_PREVIEW: accessToken.substring(0, 20) + '...'
      }
    });
    
  } catch (error) {
    console.error('❌ Error en debug:', error);
    res.status(500).json({
      success: false,
      message: 'Error en configuración PayPal',
      error: error.message,
      details: error.response?.data
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    paypal: {
      configured: !!(PAYPAL_CONFIG.CLIENT_ID && 
                   PAYPAL_CONFIG.CLIENT_SECRET && 
                   PAYPAL_CONFIG.CLIENT_ID !== 'REEMPLAZA_CON_TU_CLIENT_ID' &&
                   PAYPAL_CONFIG.CLIENT_SECRET !== 'REEMPLAZA_CON_TU_CLIENT_SECRET'),
      environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox'
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

// Endpoint para crear orden de pago con PayPal
app.post('/api/paypal/create-order', async (req, res) => {
  try {
    console.log('=== CREANDO ORDEN PAYPAL ===');
    console.log('Request body:', req.body);
    
    const { amount, currency = 'MXN', description = 'Acceso a Nutralis', userId } = req.body;

    if (!amount || !userId) {
      console.log('❌ Faltan parámetros requeridos');
      return res.status(400).json({
        success: false,
        message: 'Monto y ID de usuario son requeridos'
      });
    }

    // Validar configuración de PayPal
    if (!PAYPAL_CONFIG.CLIENT_ID || !PAYPAL_CONFIG.CLIENT_SECRET ||
        PAYPAL_CONFIG.CLIENT_ID === 'REEMPLAZA_CON_TU_CLIENT_ID' ||
        PAYPAL_CONFIG.CLIENT_SECRET === 'REEMPLAZA_CON_TU_CLIENT_SECRET') {
      console.log('❌ Credenciales de PayPal no configuradas');
      return res.status(500).json({
        success: false,
        message: 'Configuración de PayPal incompleta. Verifica las credenciales.'
      });
    }

    // Obtener token de acceso
    console.log('🔑 Obteniendo token de PayPal...');
    const accessToken = await getPayPalAccessToken();
    console.log('✅ Token obtenido exitosamente');

    // Convertir MXN a USD (tasa aproximada)
    const amountInUSD = currency === 'MXN' ? (parseFloat(amount) / 20).toFixed(2) : amount;
    
    const orderData = {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: 'MXN', // PayPal funciona mejor con USD
          value: amountInUSD.toString()
        },
        description: description,
        custom_id: userId.toString()
      }],
      application_context: {
        return_url: 'nutralis://success',
        cancel_url: 'nutralis://cancel',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW'
      }
    };

    console.log('📤 Enviando orden a PayPal:', JSON.stringify(orderData, null, 2));

    const response = await axios.post(`${PAYPAL_CONFIG.BASE_URL}/v2/checkout/orders`, orderData, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `${userId}-${Date.now()}`
      },
      timeout: 30000
    });

    const order = response.data;
    console.log('✅ Orden PayPal creada:', order.id);
    console.log('🔗 Links disponibles:', order.links.map(l => `${l.rel}: ${l.href}`));

    // Guardar orden en base de datos
    const connection = await mysql.createConnection(dbConfig);
    try {
      await connection.execute(
        `INSERT INTO ordenes_paypal (
          orden_id, usuario_id, monto, moneda, estado, 
          fecha_creacion, datos_paypal
        ) VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
        [
          order.id,
          userId,
          amountInUSD,
          'USD',
          'CREATED',
          JSON.stringify(order)
        ]
      );
      console.log('✅ Orden guardada en BD');
    } catch (dbError) {
      console.error('⚠️ Error guardando orden en BD:', dbError);
    } finally {
      await connection.end();
    }

    // Encontrar URL de aprobación
    const approvalUrl = order.links.find(link => link.rel === 'approve')?.href;
    
    if (!approvalUrl) {
      throw new Error('No se encontró URL de aprobación en la respuesta de PayPal');
    }

    console.log('🌐 URL de aprobación:', approvalUrl);

    res.json({
      success: true,
      orderId: order.id,
      approvalUrl: approvalUrl,
      data: {
        orderId: order.id,
        approvalUrl: approvalUrl,
        amount: amountInUSD,
        currency: 'USD'
      }
    });

  } catch (error) {
    console.error('❌ Error creando orden PayPal:', error);
    
    if (error.response) {
      console.error('📋 Respuesta de error de PayPal:', error.response.data);
      console.error('📊 Status de error:', error.response.status);
    }
    
    res.status(500).json({
      success: false,
      message: 'Error al crear orden de pago',
      error: error.response?.data || error.message,
      details: error.response?.data?.details || []
    });
  }
});

// Endpoint para capturar/completar el pago
app.post('/api/paypal/capture-payment', async (req, res) => {
  try {
    console.log('=== CAPTURANDO PAGO PAYPAL ===');
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: 'ID de orden es requerido'
      });
    }

    // Obtener token de acceso
    const accessToken = await getPayPalAccessToken();

    // Capturar el pago
    const response = await axios.post(
      `${PAYPAL_CONFIG.BASE_URL}/v2/checkout/orders/${orderId}/capture`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const captureData = response.data;
    console.log('✅ Pago capturado:', captureData.status);

    // Actualizar orden en base de datos
    const connection = await mysql.createConnection(dbConfig);
    try {
      // Obtener datos de la orden
      const [orderRows] = await connection.execute(
        'SELECT * FROM ordenes_paypal WHERE orden_id = ?',
        [orderId]
      );

      if (orderRows.length === 0) {
        throw new Error('Orden no encontrada en base de datos');
      }

      const orderData = orderRows[0];

      // Actualizar estado de la orden
      await connection.execute(
        `UPDATE ordenes_paypal SET 
          estado = ?, 
          fecha_captura = NOW(), 
          datos_captura = ?
        WHERE orden_id = ?`,
        [
          captureData.status,
          JSON.stringify(captureData),
          orderId
        ]
      );

      // Si el pago fue exitoso, dar acceso al usuario
      if (captureData.status === 'COMPLETED') {
        console.log('💰 Pago completado exitosamente');

        const userId = orderData.usuario_id;
        
        // Verificar en qué tabla está el usuario
        const [clientRows] = await connection.execute(
          'SELECT id_cli FROM clientes WHERE id_cli = ?',
          [userId]
        );

        const [nutRows] = await connection.execute(
          'SELECT id_nut FROM nutriologos WHERE id_nut = ?',
          [userId]
        );

        if (clientRows.length > 0) {
          // Es un cliente
          await connection.execute(
            'UPDATE clientes SET tiene_acceso = TRUE WHERE id_cli = ?',
            [userId]
          );
          console.log('✅ Acceso otorgado a cliente ID:', userId);
        } else if (nutRows.length > 0) {
          // Es un nutriólogo
          await connection.execute(
            'UPDATE nutriologos SET tiene_acceso = TRUE WHERE id_nut = ?',
            [userId]
          );
          console.log('✅ Acceso otorgado a nutriólogo ID:', userId);
        }

        // Registrar el pago
        await connection.execute(
          `INSERT INTO pagos_clientes (
            cliente_id, monto, fecha_pago, metodo_pago, 
            estado_pago, referencia_pago
          ) VALUES (?, ?, NOW(), 'PayPal', 'completado', ?)`,
          [
            userId,
            orderData.monto,
            orderId
          ]
        );

        // Generar token de acceso
        const accessTokenUser = `nutralis_${userId}_${Date.now()}`;
        const tokenExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 días

        res.json({
          success: true,
          message: 'Pago procesado exitosamente',
          data: {
            orderId: orderId,
            status: captureData.status,
            amount: orderData.monto,
            currency: orderData.moneda,
            accessToken: accessTokenUser,
            tokenExpires: tokenExpires.toISOString(),
            userId: userId
          }
        });
      } else {
        res.json({
          success: false,
          message: 'El pago no se completó correctamente',
          status: captureData.status
        });
      }

    } catch (dbError) {
      console.error('Error actualizando BD:', dbError);
      throw dbError;
    } finally {
      await connection.end();
    }

  } catch (error) {
    console.error('❌ Error capturando pago:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: 'Error al procesar el pago',
      error: error.response?.data || error.message
    });
  }
});

// Endpoint para verificar estado de una orden
app.get('/api/paypal/order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    const connection = await mysql.createConnection(dbConfig);
    try {
      const [rows] = await connection.execute(
        'SELECT * FROM ordenes_paypal WHERE orden_id = ?',
        [orderId]
      );

      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Orden no encontrada'
        });
      }

      const order = rows[0];
      res.json({
        success: true,
        order: {
          id: order.orden_id,
          userId: order.usuario_id,
          amount: order.monto,
          currency: order.moneda,
          status: order.estado,
          createdAt: order.fecha_creacion,
          capturedAt: order.fecha_captura
        }
      });

    } finally {
      await connection.end();
    }

  } catch (error) {
    console.error('Error consultando estado de orden:', error);
    res.status(500).json({
      success: false,
      message: 'Error al consultar estado de orden'
    });
  }
});

// Endpoints de autenticación y registro
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
          message: 'Sin acceso al sistema. Realiza el pago para continuar.',
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

// Otros endpoints existentes...
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE)`,
        [
          nombre_cli, app_cli, apm_cli, correo_cli, password_cli,
          edad_cli, sexo_cli, peso_cli, estatura_cli, faf_cli || 1.2, geb_cli || 0,
          modo || 'autonomo'
        ]
      );

      res.json({
        success: true,
        message: 'Cliente registrado exitosamente. Realiza el pago para acceder al sistema.',
        clientId: result.insertId,
        needsPayment: true
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

// Iniciar servidor
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📡 API disponible en: http://localhost:${PORT}/api`);
  console.log(`❤️ Health check: http://localhost:${PORT}/health`);
  console.log(`🔍 PayPal debug: http://localhost:${PORT}/api/paypal/debug`);
  console.log('');
  console.log('💡 Configuración PayPal:');
  console.log(`   Environment: ${process.env.NODE_ENV === 'production' ? 'Production' : 'Sandbox'}`);
  console.log(`   Client ID configurado: ${!!(PAYPAL_CONFIG.CLIENT_ID && PAYPAL_CONFIG.CLIENT_ID !== 'REEMPLAZA_CON_TU_CLIENT_ID')}`);
  console.log(`   Client Secret configurado: ${!!(PAYPAL_CONFIG.CLIENT_SECRET && PAYPAL_CONFIG.CLIENT_SECRET !== 'REEMPLAZA_CON_TU_CLIENT_SECRET')}`);
  
  if (!PAYPAL_CONFIG.CLIENT_ID || PAYPAL_CONFIG.CLIENT_ID === 'REEMPLAZA_CON_TU_CLIENT_ID') {
    console.log('');
    console.log('⚠️ ⚠️ ⚠️  IMPORTANTE  ⚠️ ⚠️ ⚠️');
    console.log('❌ PayPal no está configurado correctamente');
    console.log('📝 Crea un archivo .env con tus credenciales de PayPal');
    console.log('🔗 Guía: https://developer.paypal.com/');
  }
});