const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron'); // <-- Añadido para automatización

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
        
        // CORRECCIÓN: Los paneles SMM no entienden 'multi_status', se convierte a 'status'
        if (action === 'multi_status') {
            params.append('action', 'status');
        } else {
            params.append('action', action);
        }

        for (const [key, value] of Object.entries(extraParams)) {
            params.append(key, value);
        }

        const response = await fetch(SMM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });

        res.json(await response.json());
    } catch (error) {
        console.error("Error en /api/smm:", error);
        res.status(500).json({ error: "Error de conexión interna" });
    }
});

// 2. NUEVA RUTA: API PARA REVENDEDORES
app.post('/api/v1/reseller', async (req, res) => {
    try {
        const { key, action, service, link, quantity, order } = req.body;
        
        if (!key || !key.startsWith('luck_')) {
            return res.status(401).json({ error: "Invalid API Key format" });
        }

        const uid = key.split('_')[1];

        const userRes = await fetch(`${FIREBASE_DB_URL}/users/${uid}.json`);
        const userData = await userRes.json();

        if (!userData || userData.apiKey !== key) {
            return res.status(401).json({ error: "Unauthorized API Key" });
        }

        if (action === 'balance') {
            return res.json({ 
                balance: parseFloat(userData.balance || 0).toFixed(4), 
                currency: "USD" 
            });
        }

        if (action === 'services') {
            const smmRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: 'services' })
            });
            const services = await smmRes.json();
            
            const markedUpServices = services.map(s => ({
                ...s,
                rate: (parseFloat(s.rate) * PROFIT_MARGIN).toFixed(4)
            }));
            
            return res.json(markedUpServices);
        }

        if (action === 'add') {
            if (!service || !link || !quantity) return res.status(400).json({ error: "Missing parameters: service, link, quantity required" });
            
            const smmRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: 'services' })
            });
            const services = await smmRes.json();
            
            const targetService = services.find(s => s.service == service);
            if (!targetService) return res.status(400).json({ error: "Invalid service ID" });

            const unitPrice = parseFloat(targetService.rate) * PROFIT_MARGIN;
            const totalCost = (unitPrice / 1000) * parseInt(quantity);
            const userBalance = parseFloat(userData.balance || 0);

            if (userBalance < totalCost) {
                return res.status(400).json({ error: "Insufficient balance in your LUCK XIT account" });
            }

            const addRes = await fetch(SMM_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ key: API_KEY, action: 'add', service, link, quantity })
            });
            const addData = await addRes.json();

            if (addData.order) {
                const newBalance = userBalance - totalCost;
                await fetch(`${FIREBASE_DB_URL}/users/${uid}.json`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ balance: newBalance })
                });
                
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
                return res.status(400).json(addData);
            }
        }

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

// ==========================================
// TAREA AUTOMÁTICA (CRON JOB) - SINCRONIZACIÓN SMM (Cada 10 mins)
// ==========================================
cron.schedule('*/10 * * * *', async () => {
    console.log('[CRON] Iniciando sincronización automática de pedidos SMM...');
    try {
        const usersRes = await fetch(`${FIREBASE_DB_URL}/users.json`);
        const users = await usersRes.json();
        
        if (!users) return;

        let ordersToSync = [];
        let orderMap = {};

        for (const [uid, userData] of Object.entries(users)) {
            if (userData.history) {
                for (const [historyKey, order] of Object.entries(userData.history)) {
                    if (order.type === 'smm' && order.smmOrderId && !order.refunded) {
                        const status = (order.smmStatus || 'pending').toLowerCase();
                        if (status !== 'completed' && status !== 'canceled' && status !== 'partial') {
                            ordersToSync.push(order.smmOrderId);
                            orderMap[order.smmOrderId] = { uid, historyKey, price: order.price || 0 };
                        }
                    }
                }
            }
        }

        if (ordersToSync.length === 0) return;

        const params = new URLSearchParams();
        params.append('key', API_KEY);
        params.append('action', 'status');
        params.append('orders', ordersToSync.join(','));

        const smmRes = await fetch(SMM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        const smmStatuses = await smmRes.json();

        for (const [smmId, apiData] of Object.entries(smmStatuses)) {
            if (!apiData || apiData.error || !apiData.status) continue;
            
            const orderInfo = orderMap[smmId];
            if (!orderInfo) continue;

            const newStatus = apiData.status;
            const statusLower = newStatus.toLowerCase();
            const isCanceled = (statusLower === 'canceled' || statusLower === 'error');

            const historyUpdate = { smmStatus: newStatus };
            if (isCanceled) historyUpdate.refunded = true;

            await fetch(`${FIREBASE_DB_URL}/users/${orderInfo.uid}/history/${orderInfo.historyKey}.json`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(historyUpdate)
            });

            if (isCanceled) {
                const freshUserRes = await fetch(`${FIREBASE_DB_URL}/users/${orderInfo.uid}.json`);
                const freshUserData = await freshUserRes.json();
                const updatedBalance = parseFloat(freshUserData.balance || 0) + parseFloat(orderInfo.price);

                await fetch(`${FIREBASE_DB_URL}/users/${orderInfo.uid}.json`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ balance: updatedBalance })
                });
            }
        }
        console.log('[CRON] Sincronización finalizada con éxito.');
    } catch (error) {
        console.error('[CRON] Error en la sincronización:', error);
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Backend de LUCK XIT activo en el puerto ${PORT}`);
});
