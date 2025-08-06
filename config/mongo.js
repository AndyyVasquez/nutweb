const { MongoClient } = require('mongodb');

const uri = 'mongodb://localhost:27017'; 
const client = new MongoClient(uri);

let db;

async function connectToMongo() {
  if (!db) {
    await client.connect();
    db = client.db('nutralis');
  }
  return db;
}

module.exports = connectToMongo;
