const bcrypt = require('bcryptjs');
const db = require('./config/db'); // Ajusta la ruta según tu proyecto

const admins = [
  { id: 1, password: 'NutrAlis123' },
  { id: 2, password: 'NutrAlis123' },
  { id: 3, password: 'NutrAlis123' },
];

async function actualizarContrasenas() {
  for (const admin of admins) {
    try {
      const hash = await bcrypt.hash(admin.password, 10);
      db.query(
        'UPDATE administradores SET password = ? WHERE id_admin = ?',
        [hash, admin.id],
        (err, result) => {
          if (err) {
            console.error(`Error actualizando admin ${admin.id}:`, err);
          } else {
            console.log(`Contraseña actualizada para admin ${admin.id}`);
          }
        }
      );
    } catch (error) {
      console.error('Error en hash:', error);
    }
  }
}

actualizarContrasenas();
