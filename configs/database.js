const sqlObj = require("mssql");

const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    options: {
        encrypt: false,
        trustServerCertificate: true
    }
};

let dbPool = null;

async function connectDB() {
    try {
        dbPool = await sqlObj.connect(config);
        console.log("MSSQL Server connected !");
        return dbPool;
    }
    catch(error) {
        console.log("Connect Error:", error);
        throw error;
    }
}

function getDBPool() {
    if (!dbPool) {
        throw new Error("Database has not been connected yet.");
    }

    return dbPool;
}

module.exports = {
    sqlObj, connectDB, getDBPool
}