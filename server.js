const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Railway asigna automáticamente el puerto en process.env.PORT
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Servir estáticamente el HTML desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Credenciales API
const API_KEY = process.env.SMM_API_KEY || "sk_live_2676ddf0f84e379fe7b6ee3698224310e06a132fb127ad0e";
const SMM_URL = "https://smmzing.com/api/v3";

// Ruta segura para procesar peticiones
app.post('/api/smm', async (req, res) => {
    try {
        const { action, ...extraParams } = req.body;

        if (!action) {
            return res.status(400).json({ error: "Falta la acción a ejecutar" });
        }

        const params = new URLSearchParams();
        params.append('key', API_KEY);
        params.append('action', action);
        
        for (const [key, value] of Object.entries(extraParams)) {
            params.append(key, value);
        }

        const response = await fetch(SMM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });

        const data = await response.json();
        res.json(data);

    } catch (error) {
        console.error("Error en el servidor:", error);
        res.status(500).json({ error: "Fallo de conexión externa" });
    }
});

// Cualquier otra ruta redirige a tu index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Servidor activo en el puerto ${PORT}`);
});
