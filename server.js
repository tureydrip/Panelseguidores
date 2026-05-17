const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// === CREDENCIALES Y CONFIGURACIÓN ===
const API_KEY = process.env.SMM_API_KEY || "sk_live_2676ddf0f84e379fe7b6ee3698224310e06a132fb127ad0e";
const SMM_URL = "https://smmzing.com/api/v3";
const FIREBASE_DB_URL = "https://loginhackstore-default-rtdb.firebaseio.com";
const PROFIT_MARGIN = 1.20; // 20% de ganancia

// 1. RUTA CLÁSICA (Para las compras directas desde tu HTML)
app.post('/api/smm', async (req, res) => {
    try {
        const { action, ...extraParams } = req.body;
        if (!action) return res.status(400).json({ error: "La acción es requerida" });

        const params = new URLSearchParams();
        params.append('key', API_KEY);
        params.append('action', action);
        for (const [key, value] of Object.entries(extraParams)) params.append(key, value);

        const response = await fetch(SMM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });

        res.json(await response.json());
    } catch (error) {
        res.status(500).json({ error: "Error de conexión interna" });
    }
});

// 2. NUEVA RUTA: API PARA REVENDEDORES
app.post('/api/v1/reseller', async (req, res) => {
    try {
        const { key, action, service, link, quantity, order } = req.body;
        
        // Verificación básica del formato de la llave (Ej: luck_UID_randomHex)
        if (!key || !key.startsWith('luck_')) {
            return res.status(401).json({ error: "Invalid API Key format" });
        }

        const uid = key.split('_')[1];

        // Obtener datos del usuario desde Firebase vía REST
        const userRes = await fetch(`${FIREBASE_DB_URL}/users/${uid}.json`);
        const userData = await userRes.json();

        // Validar si el usuario existe y si la llave coincide
        if (!userData || userData.apiKey !== key) {
            return res.status(401).json({ error: "Unauthorized API Key" });
        }

        // ==========================================
        // ACCIÓN: BALANCE
        // ==========================================
        if (action === 'balance') {
            return res.json({ 
                balance: parseFloat(userData.balance || 0).toFixed(4), 
                currency: "USD" 
            });
        }

        // ==========================================
        // ACCIÓN: SERVICIOS
        // ==========================================
        if (action === 'services') {
            const smmRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: 'services' })
            });
            const services = await smmRes.json();
            
            // Inyectar el margen de ganancia de LUCK XIT a los revendedores
            const markedUpServices = services.map(s => ({
                ...s,
                rate: (parseFloat(s.rate) * PROFIT_MARGIN).toFixed(4)
            }));
            
            return res.json(markedUpServices);
        }

        // ==========================================
        // ACCIÓN: ADD (CREAR ORDEN)
        // ==========================================
        if (action === 'add') {
            if (!service || !link || !quantity) return res.status(400).json({ error: "Missing parameters: service, link, quantity required" });
            
            // 1. Consultar SMMZing para conocer el precio base real del servicio
            const smmRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: 'services' })
            });
            const services = await smmRes.json();
            
            const targetService = services.find(s => s.service == service);
            if (!targetService) return res.status(400).json({ error: "Invalid service ID" });

            // 2. Calcular costo total para el revendedor
            const unitPrice = parseFloat(targetService.rate) * PROFIT_MARGIN;
            const totalCost = (unitPrice / 1000) * parseInt(quantity);
            const userBalance = parseFloat(userData.balance || 0);

            // 3. Validar fondos
            if (userBalance < totalCost) {
                return res.status(400).json({ error: "Insufficient balance in your LUCK XIT account" });
            }

            // 4. Enviar orden a SMMZing
            const addRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: 'add', service, link, quantity })
            });
            const addData = await addRes.json();

            if (addData.order) {
                // 5. Descontar saldo en Firebase
                const newBalance = userBalance - totalCost;
                await fetch(`${FIREBASE_DB_URL}/users/${uid}.json`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ balance: newBalance })
                });
                
                // 6. Registrar en el historial del revendedor
                const historyEntry = {
                    type: 'smm', 
                    smmOrderId: addData.order, 
                    serviceName: `(API) ${targetService.name}`,
                    link: link, 
                    quantity: parseInt(quantity), 
                    price: totalCost,
                    date: Date.now(), 
                    smmStatus: 'Pending', 
                    refunded: false
                };

                await fetch(`${FIREBASE_DB_URL}/users/${uid}/history.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(historyEntry)
                });

                return res.json({ order: addData.order });
            } else {
                return res.status(400).json(addData); // Retorna el error de SMMZing (Ej: link inválido)
            }
        }

        // ==========================================
        // ACCIÓN: STATUS
        // ==========================================
        if (action === 'status') {
            if (!order) return res.status(400).json({ error: "Missing order ID" });
            
            const statusRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: 'status', order })
            });
            
            return res.json(await statusRes.json());
        }

        return res.status(400).json({ error: "Invalid action" });

    } catch (err) {
        console.error("API Reseller Error:", err);
        return res.status(500).json({ error: "Internal server error connecting to SMM provider" });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Backend de LUCK XIT activo en el puerto ${PORT}`);
});
