const mysql = require('mysql2');

const dbConfig = {
  host: 'integradora1.com',
  user: 'integ117_andrea',
  password: 'Nutralis2025!',
  database: 'integ117_nutralis',
};

const connection = mysql.createConnection(dbConfig);

// Conexión a la base de datos
connection.connect((err) => {
  if (err) {
    console.error('Error al conectar a la base de datos:', err);
    return;
  }
  console.log('Conexión a la base de datos MySQL establecida.');
});


module.exports = connection;
