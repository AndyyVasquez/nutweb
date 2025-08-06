const axios = require('axios');

async function traducir() {
  try {
    const respuesta = await axios.post('https://libretranslate.de/translate', {
      q: 'manzana',
      source: 'es',
      target: 'en',
      format: 'text'
    });

    console.log(respuesta.data); // { translatedText: 'apple' }
  } catch (error) {
    console.error('Error en la traducción:', error.message);
  }
}

traducir();
